import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { ConnectedServiceCredentialHttpClient } from '@/api/client/connectedServiceCredentialApi';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createConnectedAccountContributionRegistry } from '@/plugins/runtime/connectedAccounts/contributionRegistry';
import { createConnectedAccountHostRuntimeInvoker } from '@/plugins/runtime/connectedAccounts/runtimeInvoker';
import type { HostConnectedAccountReadContext } from '@/plugins/runtime/connectedAccounts/hostRuntime';
import { createLoggerAndEventsAvailablePluginInvocationServiceBinding } from '@/plugins/runtime/invocation/services/factory';
import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import { createQualifiedConnectedAccountDaemonPersistence } from './qualifiedConnectedAccountDaemonPersistence';
import { createQualifiedConnectedAccountAttemptTransactionAdapters } from './qualifiedConnectedAccountAttemptTransactionAdapters';
import { createQualifiedConnectedAccountEstablishedRuntimeOwner } from './qualifiedConnectedAccountEstablishedRuntimeOwner';

afterEach(() => vi.restoreAllMocks());

async function authorityFixture() {
  const channel = await createRequesterCurrentnessSocketHarness();
  const accountId = 'qualified-authority-account';
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`, encryption: null };
  const account = { service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: 'connected-1' };
  let currentness: AccountEncryptionCurrentnessResponse = { mode: 'plain', version: 1, updatedAt: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null };
  let currentnessReads = 0;
  const mutations: string[] = [];
  const credential = { ref: account, authenticationModeId: 'token', revisionSemantics: 'revisioned',
    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null,
    content: sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'plain',
      payload: { v: 1, values: { token: 'private-token' } }, randomBytes: length => new Uint8Array(length) }), metadata: { scopes: [] } };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const path = request.url?.split('?')[0];
    if (path === '/v1/account/encryption/currentness' || path === '/v1/account/encryption') {
      currentnessReads++;
      response.end(JSON.stringify(path === '/v1/account/encryption'
        ? { mode: currentness.mode, updatedAt: currentness.updatedAt } : currentness));
    } else if (request.method === 'GET' && path === '/v4/connect/qualified/credential') {
      response.end(JSON.stringify(credential));
    } else if (request.method === 'GET' && path === '/v4/connect/qualified/configuration') {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not-found' }));
    } else if (request.method !== 'GET') {
      mutations.push(`${request.method} ${path}`);
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'unexpected-mutation' }));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'unsupported' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token: credentials.token, serverBaseUrl: base });
  const api = new ConnectedServiceCredentialHttpClient(credentials);
  const getAccountEncryptionMode: ConnectedServiceCredentialHttpClient['getAccountEncryptionMode'] = options => api.getAccountEncryptionMode(options);
  const persistence = createQualifiedConnectedAccountDaemonPersistence({ credentials, getAccountEncryptionMode,
    secrets: { admit: async () => {}, has: async () => false, read: async () => null } });
  const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
    id: account.service.localId, title: 'Authority fixture', authentication: { defaultModeId: 'token', modes: [{
      id: 'token', kind: 'manual', outcomeReconciliation: 'none',
      fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
    }] },
  });
  const runtime = { authentication: { modes: {} }, refresh: async () => ({ status: 'connected' as const }),
    revoke: async () => ({ status: 'remoteUnsupported' as const }), status: async () => ({ status: 'connected' as const }),
    materialize: async (_request: unknown, context: HostConnectedAccountReadContext) => ({ kind: 'environment' as const,
      env: { TOKEN: (await context.credentials.get('token')) ?? '' } }),
    quota: async () => { throw new Error('Source capture must not invoke provider quota work'); } };
  const contributions = createConnectedAccountContributionRegistry({ descriptors: [], activateOnDemand: async () => {},
    readRegistrations: () => [], readPluginOccurrenceId: () => null, readPluginSourceCustody: () => null,
    isPluginOccurrenceCurrent: () => false });
  contributions.registerHostConnectedAccountRuntime({ ref: account.service, descriptor, runtime });
  const contribution = contributions.describe(account.service);
  if (!contribution) throw new Error('Fixture host contribution missing');
  const runtimeLease = { owner: 'host' as const, ref: account.service, descriptor, runtime,
    occurrenceId: contribution.occurrenceId, sourceCustody: { kind: 'host' as const }, isCurrent: () => true };
  const invoker = createConnectedAccountHostRuntimeInvoker({ resolveRuntime: async () => runtimeLease,
    resolvePlugin: () => ({ version: '1.0.0', hostAccessRequests: [] }),
    resolveHostPolicy: () => ({ hostAccess: [], serviceBinding:
      createLoggerAndEventsAvailablePluginInvocationServiceBinding('fixture', 'producer', []) }),
    // This host contribution calls no platform services; invocation and guards remain real.
    createServices: () => ({}) as PluginInvocationContext['services'], registerRawForRedaction() {},
    resolveHostOwnedConfiguredEndpoints: () => [] });
  const registry = { connectedAccountContributions: contributions, resolveConnectedAccountRuntime: async () => runtimeLease,
    connectedAccountRuntimeInvoker: invoker };
  const owner = createQualifiedConnectedAccountEstablishedRuntimeOwner({ credentials,
    // The plugin loader is the external boundary; its real registry and invoker are consumed below.
    reloadController: { acquireRuntimeRegistry: async () => ({ registry, source: 'active', release: async () => {} }),
      isRuntimeRegistryCurrent: () => true } as unknown as Pick<PluginReloadController, 'acquireRuntimeRegistry' | 'isRuntimeRegistryCurrent'>,
    getAccountEncryptionMode: (signal, options) => api.getAccountEncryptionMode({ ...options, signal }),
    configuration: persistence.configuration });
  return { account, credentials, persistence, owner, getAccountEncryptionMode, channel,
    run: <T>(operation: () => T) => runWithServerHttpBaseUrl(base, operation),
    reads: () => currentnessReads, mutations,
    async warm() {
      await holder.read();
      await runWithServerHttpBaseUrl(base, async () => {
        await expect(api.getAccountEncryptionMode()).resolves.toBe('plain');
        await expect(api.getAccountEncryptionMode()).resolves.toBe('plain');
      });
      expect(currentnessReads).toBe(1);
    },
    flip() {
      currentness = { mode: 'e2ee', version: 2, updatedAt: 2, signingKeyFingerprint: 'new-signing', contentKeyFingerprint: 'new-content' };
      expect(channel.clients.every(client => client.connected)).toBe(true);
    },
    async close() {
      contributions.dispose();
      await holder.dispose(); await channel.close(); server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

it('refuses account configuration sealing with retired observed plain authority before CAS', async () => {
  const f = await authorityFixture();
  try {
    await f.warm(); f.flip();
    await expect(f.run(() => f.persistence.configuration.replace({ target: { kind: 'account', account: f.account, modeId: 'token' },
      expectedRevision: null, replacement: { values: { endpoint: 'https://private.example' }, secretRefs: {} },
      occurrenceId: 'fixture', sourceCustody: { kind: 'host' } }))).resolves.toMatchObject({ status: 'unavailable' });
    expect(f.mutations).toEqual([]);
    expect(f.reads()).toBe(2);
  } finally { await f.close(); }
});

it('refuses credential settlement with retired observed plain authority before CAS', async () => {
  const f = await authorityFixture();
  try {
    await f.warm(); f.flip();
    await expect(f.run(() => f.persistence.attempts.settlement.settle({ intent: 'connect', service: f.account.service,
      accountId: f.account.accountId, authenticationModeId: 'token', expectedCredentialRevision: null,
      expectedCredentialConfigurationRevision: null, expectedConfigurationRevision: 'unconfigured',
      stagedCredentials: { token: 'private-token' }, sourceCustody: { kind: 'host' }, displayName: 'Account', scopes: [] }))).rejects.toThrow();
    expect(f.mutations).toEqual([]);
    expect(f.reads()).toBeGreaterThan(1);
  } finally { await f.close(); }
});

it('refuses durable attempt sealing with retired observed plain authority before storage', async () => {
  const f = await authorityFixture();
  try {
    await f.warm(); f.flip();
    const adapters = createQualifiedConnectedAccountAttemptTransactionAdapters({ credentials: f.credentials,
      getAccountEncryptionMode: f.getAccountEncryptionMode, getMachineId: () => 'machine' });
    await expect(f.run(() => adapters.oauth.create({ attemptId: 'attempt', service: f.account.service,
      callbackUrl: 'https://provider.example/callback', snapshot: { attemptId: 'attempt', createdAtMs: Date.now(),
        intent: 'connect', service: f.account.service, modeId: 'token', sourceCustody: { kind: 'host' }, phase: 'starting',
        expectedCredentialRevision: null, expectedCredentialConfigurationRevision: null, expectedConfigurationRevision: 'unconfigured',
        stagedCredentials: { token: 'private-token' } } }))).rejects.toThrow();
    expect(f.mutations).toEqual([]);
    expect(f.reads()).toBe(2);
  } finally { await f.close(); }
});

it('freshly checks authority only when an established invocation lazily seals a replacement', async () => {
  const f = await authorityFixture();
  try {
    await f.warm();
    const receipt = await f.run(() => f.owner.invokeWithReceipt({ account: f.account,
      operation: { kind: 'materialize', request: { kind: 'environment', keys: ['TOKEN'] } } }));
    expect(receipt.result).toEqual({ kind: 'environment', env: { TOKEN: 'private-token' } });
    expect(f.reads()).toBe(1);
    f.flip();
    await expect(f.run(async () => receipt.basis.prepareCredentialReplacement({ set: { token: 'rotated' }, delete: [] })))
      .rejects.toThrow();
    expect(f.reads()).toBe(2);
    expect(f.mutations).toEqual([]);
  } finally { await f.close(); }
});

it.each(['capture', 'current'] as const)('retains the fresh final quota authority comparison at %s', async phase => {
  const f = await authorityFixture();
  try {
    await f.warm();
    if (phase === 'capture') f.flip();
    const snapshot = await f.run(() => f.owner.readQuotaSourceSnapshot({ account: f.account,
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null, accountMode: 'plain' }));
    if (phase === 'capture') expect(snapshot).toBeNull();
    else {
      expect(snapshot).not.toBeNull(); f.flip();
      await expect(f.run(() => snapshot!.isCurrent())).resolves.toBe(false);
    }
    expect(f.reads()).toBeGreaterThan(1);
  } finally { await f.close(); }
});
