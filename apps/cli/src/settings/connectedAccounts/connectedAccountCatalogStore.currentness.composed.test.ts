import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1, ConnectedAccountCatalogRowMutationV1Schema,
  ConnectedAccountCatalogRowReadResponseV1Schema, emptyConnectedAccountCatalogRecordV1,
  sealConnectedAccountCatalogContentV1, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { createCliConnectedAccountCatalogStore } from './connectedAccountCatalogStore';
import { readActiveConnectedAccountCatalog } from './hydrateConnectedAccountCatalog';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

it.each([
  { state: 'active', custody: 'daemon' }, { state: 'absent', custody: 'daemon' },
  { state: 'active', custody: 'requester' }, { state: 'absent', custody: 'requester' },
] as const)('reobserves current purpose authority without maintenance while preserving activation ($state, $custody)', async ({ state, custody }) => {
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: `purpose-current-${state}` })).toString('base64url')}.signature`, encryption: null };
  const record = emptyConnectedAccountCatalogRecordV1('purposes');
  let row = ConnectedAccountCatalogRowReadResponseV1Schema.parse(state === 'absent' ? { status: 'absent' }
    : { status: 'present', revision: 2, content: sealConnectedAccountCatalogContentV1({ mode: 'plain', material: null, record }) });
  const requests: string[] = [];
  const mutations: ReturnType<typeof ConnectedAccountCatalogRowMutationV1Schema.parse>[] = [];
  let boundaryError: unknown;
  const server = createServer(async (request, response) => {
    const path = request.url;
    requests.push(`${request.method} ${path}`);
    response.setHeader('Content-Type', 'application/json');
    try {
      if (path === '/v1/account/encryption/currentness') {
        response.end(JSON.stringify({ mode: 'plain', version: 1, settingsVersion: 7,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
      } else if (path === '/v1/account/entity-rows/connected-accounts/purposes' && request.method === 'GET') {
        response.end(JSON.stringify(row));
      } else if (path === '/v1/account/entity-rows/connected-accounts/purposes' && request.method === 'POST') {
        let body = '';
        for await (const chunk of request) body += String(chunk);
        const mutation = ConnectedAccountCatalogRowMutationV1Schema.parse(JSON.parse(body));
        mutations.push(mutation);
        row = ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 2, content: mutation.content });
        response.end(JSON.stringify({ status: 'updated', revision: 2, cursor: 1 }));
      } else if (path === '/v2/account/settings' && request.method === 'GET') {
        response.end(JSON.stringify({ version: 7, content: { t: 'plain', v: state === 'absent'
          ? { [CONNECTED_ACCOUNT_CATALOG_RETAINED_ROOTS_V1.purposes]: record.value } : {} } }));
      } else if (path === '/v2/account/settings/history') {
        response.end(JSON.stringify({ snapshots: [] }));
      } else if (path === '/v1/account/entity-rows/profiles/transfer') {
        response.end(JSON.stringify({ status: 'absent' }));
      } else {
        // Source cleanup failure must not undo acknowledged initialization.
        response.statusCode = request.method === 'POST' ? 503 : 404;
        response.end(JSON.stringify({ error: 'unavailable' }));
      }
    } catch (error) {
      boundaryError = error;
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'invalid-fixture-request' }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await runWithServerHttpBaseUrl(base, async () => {
      const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials),
        ...(state === 'active' ? { connectedPurposeCatalog: { status: 'ready' as const, revision: 1, record } } : {}) };
      // Requester custody is admitted at its real boundary; the final Account
      // mode proof still comes from HTTP. Its snapshot must override the daemon.
      const operationContext = custody === 'requester' ? createInvocationSavedSecretOperationContextV1({
        credentials, snapshot, serverHttpBaseUrl: base, isCurrent: async () => true,
      }) : undefined;
      setActiveAccountSettingsSnapshot(operationContext ? { ...snapshot, scopeKey: 'foreign-daemon',
        connectedPurposeCatalog: state === 'absent' ? { status: 'ready', revision: 1, record } : undefined } : snapshot);
      const daemonSnapshot = getActiveAccountSettingsSnapshot();
      const catalog = await readActiveConnectedAccountCatalog({ credentials, key: 'purposes', operationContext });
      expect(catalog, JSON.stringify({ catalog, requests, mutations, boundaryError })).toMatchObject({ status: 'ready', revision: 2 });
      expect(boundaryError).toBeUndefined();
      expect((operationContext ? operationContext.readSnapshot() : getActiveAccountSettingsSnapshot())?.connectedPurposeCatalog)
        .toMatchObject({ status: 'ready', revision: 2 });
      if (operationContext) expect(getActiveAccountSettingsSnapshot()).toBe(daemonSnapshot);
      if (state === 'absent') {
        expect(mutations).toMatchObject([{ expectedRevision: 'absent', sourceSettingsVersion: 7 }]);
      } else {
        expect(mutations).toEqual([]);
        expect(requests.filter(path => path !== 'GET /v1/account/entity-rows/connected-accounts/purposes'
          && path !== 'GET /v1/account/encryption/currentness')).toEqual([]);
      }
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function catalogAuthorityFixture() {
  const channel = await createRequesterCurrentnessSocketHarness();
  const accountId = 'catalog-authority-account';
  const secret = new Uint8Array(32).fill(7);
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
    encryption: { type: 'legacy' as const, secret } };
  const material = credentials.encryption;
  const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint);
  let currentness: AccountEncryptionCurrentnessResponse = { mode: 'e2ee', version: 1,
    signingKeyFingerprint: 'signing-current', contentKeyFingerprint: fingerprint, updatedAt: 1 };
  const record: ConnectedAccountCatalogRecordV1 = { key: 'configurations', value: { v: 1, entries: [{
    service: { pluginId: 'happier.connected-account.test', localId: 'api' }, modeId: 'api-key', revision: 'configured',
    values: { endpoint: 'https://private.example.test' }, secretRefs: {},
  }] } };
  const row = { status: 'present', revision: 4, content: sealConnectedAccountCatalogContentV1({ mode: 'e2ee', material, record }) };
  let revoked = false;
  let reads = 0;
  let holdRow = false;
  const rowRequested = deferred();
  const releaseRow = deferred();
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/account/encryption/currentness') {
      reads++;
      response.statusCode = revoked ? 401 : 200;
      response.end(JSON.stringify(revoked ? { error: 'unauthorized' } : currentness));
    } else if (request.url === '/v1/account/entity-rows/connected-accounts/configurations') {
      if (holdRow) { rowRequested.resolve(); await releaseRow.promise; }
      response.end(JSON.stringify(row));
    } else { response.statusCode = 404; response.end(JSON.stringify({ error: 'unsupported' })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token: credentials.token, serverBaseUrl: base });
  const store = runWithServerHttpBaseUrl(base, () => {
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    return createCliConnectedAccountCatalogStore({ credentials });
  });
  return {
    store, record, channel, rowRequested, releaseRow,
    warm: () => holder.read(),
    reads: () => reads,
    holdRow: () => { holdRow = true; },
    change(change: 'mode' | 'epoch') {
      if (change === 'epoch') revoked = true;
      else currentness = { mode: 'plain', version: 2, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 2 };
    },
    async close() {
      releaseRow.resolve();
      await holder.dispose();
      await channel.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

it('borrows warm catalog identity while freshly admitting each opened result', async () => {
  const f = await catalogAuthorityFixture();
  try {
    await f.warm();
    for (let read = 0; read < 2; read++) {
      await expect(f.store.readAdmittedCatalog('configurations')).resolves.toMatchObject({ status: 'ready', record: f.record });
    }
    // One socket warm-up plus exactly one final HTTP authority point per read.
    expect(f.reads()).toBe(3);
  } finally { await f.close(); }
});

it.each([
  ['mode', false], ['epoch', false], ['mode', true], ['epoch', true],
] as const)('withholds opened catalog after committed %s before socket delivery (gap=%s)', async (change, gap) => {
  const f = await catalogAuthorityFixture();
  try {
    await f.warm();
    f.holdRow();
    const read = f.store.readAdmittedCatalog('configurations');
    const settled = read.then(value => ({ value }), error => ({ error }));
    await f.rowRequested.promise;
    f.change(change);
    if (gap) await f.channel.disconnect();
    else expect(f.channel.clients.every(client => client.connected)).toBe(true);
    f.releaseRow.resolve();
    const result = await settled;
    if (change === 'mode') expect(result).toEqual({ value: { status: 'unavailable', reason: 'account-mode-mismatch' } });
    else expect(result).toMatchObject({ error: { code: 'account_encryption_currentness_unavailable' } });
  } finally { await f.close(); }
});

it.each(['mode', 'epoch'] as const)('refuses early ready publication after committed %s while the private response is held', async change => {
  const f = await catalogAuthorityFixture();
  try {
    await f.warm();
    f.holdRow();
    const published: unknown[] = [];
    const read = f.store.readCatalog('configurations', async catalog => { published.push(catalog); });
    const settled = read.then(value => ({ value }), error => ({ error }));
    await f.rowRequested.promise;
    f.change(change);
    expect(f.channel.clients.every(client => client.connected)).toBe(true);
    f.releaseRow.resolve();
    expect(await settled).toHaveProperty('error');
    expect(published).toEqual([]);
  } finally { await f.close(); }
});
