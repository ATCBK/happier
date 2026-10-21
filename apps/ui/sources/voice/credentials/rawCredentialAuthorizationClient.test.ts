/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema,
  DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema } from '@happier-dev/protocol/daemon/voiceCredentials';
import { PluginPermissionGrantV1Schema, PluginPermissionGrantRequestV1Schema } from '@happier-dev/protocol/plugins/permissions/grants';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit';
import { createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async original => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(original));
const daemonResponse = vi.fn<(method: string, payload: unknown) => Promise<unknown>>();
const requests = installSessionActionRpcBoundary(request => {
  const prefix = 'machine-1:';
  if (!request.method.startsWith(prefix)) throw new Error(`Unexpected machine transport method: ${request.method}`);
  return daemonResponse(request.method.slice(prefix.length), request.params);
});
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { createPluginPermissionGrantActions } = await import('@/sync/domains/plugins/permissions/actions');
const { createPluginPermissionGrantHttpActionExecutor } = await import('@/sync/domains/plugins/permissions/api');
const { inspectRawCredentialAuthorizationReadiness, RawCredentialAuthorizationClient } = await import('./rawCredentialAuthorizationClient');

const contribution = Object.freeze({ pluginId: 'acme.voice', localId: 'browser' });
const rawGrant = Object.freeze({
  realm: 'daemon' as const,
  phase: 'speech' as const,
  request: Object.freeze({
    kind: 'httpHeaders' as const,
    origin: 'https://voice.example.test',
    headerNames: Object.freeze(['authorization']),
  }),
});

const inspection = DaemonVoiceClientRawCredentialAuthorizationInspectResponseV1Schema.parse({
  ok: true,
  authorization: {
    pluginId: contribution.pluginId,
    capability: 'credentials.materialize.raw' as const,
    targetScope: { kind: 'account' as const },
    subject: {
      kind: 'credential_access_disclosure' as const,
      contribution,
      credentialSlotId: 'api_key',
      purpose: 'voice.browser',
      accessDeclarationDigest: 'b'.repeat(64),
      selectedAuthorityDigest: 'c'.repeat(64),
      selectedRawAccessDigest: 'd'.repeat(64),
    },
    // The daemon only ever authorizes as an exact machine installation, so the
    // response carries the installation whose approval a client must match.
    authoritySource: {
      kind: 'machine_installation' as const,
      machineId: 'machine-1',
      installationId: 'installation-1',
    },
    disclosures: [{
      sourceClass: { kind: 'savedSecret' as const, secretKinds: ['apiKey' as const] },
      realm: rawGrant.realm,
      phase: rawGrant.phase,
      materialization: 'httpHeaders' as const,
      origin: 'https://voice.example.test',
      destination: 'authorization',
    }],
  },
  review: {
    plugin: { id: contribution.pluginId, name: 'Acme Voice', version: '2.0.0' },
    package: { identity: '@acme/voice' },
    distribution: { kind: 'unavailable' as const },
    publisher: { status: 'unavailable' as const },
    contribution: { identity: contribution, name: 'Browser Voice' },
    credentialSlot: { id: 'api_key', name: 'API key', purpose: 'voice.browser' },
  },
});
if (!inspection.ok) throw new Error('Expected admitted inspection fixture');
const { authorization } = inspection;
const pendingRequest = PluginPermissionGrantRequestV1Schema.parse({
  v: 1, id: 'request-1', accountId: 'account-a', pluginId: contribution.pluginId,
  capability: authorization.capability, targetScope: authorization.targetScope,
  subject: authorization.subject, authoritySource: authorization.authoritySource,
  requester: { kind: 'plugin', pluginId: contribution.pluginId },
  reason: 'Voice provider raw credential access review', status: 'pending', createdAt: 1, updatedAt: 1,
});
const requested = DaemonVoiceClientRawCredentialAuthorizationRequestResponseV1Schema.parse({
  ...inspection, pendingRequest,
});
const grant = PluginPermissionGrantV1Schema.parse({
  v: 1, id: 'grant-1', accountId: 'account-a', pluginId: contribution.pluginId,
  capability: authorization.capability, targetScope: authorization.targetScope,
  subject: authorization.subject, authoritySource: authorization.authoritySource,
  status: 'active', requestId: pendingRequest.id, grantedByUserId: 'user-1', grantedAt: 2, createdAt: 2, updatedAt: 2,
});

let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let webLocks: ReturnType<typeof installWebLockManagerMock>;
const permissionHttp = vi.fn<NonNullable<NonNullable<Parameters<typeof createPluginPermissionGrantHttpActionExecutor>[0]>['request']>>();

beforeEach(async () => {
  webLocks = installWebLockManagerMock();
  account = await restoreServerAccountForTest({ serverUrl: 'https://raw-authorization.test',
    accountId: 'account-a', credentialScope: 'restored-home', request: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
      if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
      if (path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' })]);
      if (path === '/v1/machines/read-batch' && init?.method === 'POST') return createMachineReadBatchResponseFixture(init.body,
        id => id === 'machine-1' ? createPlainMachineRowFixture({ id, accountId: 'account-a' }) : null);
      if (path === '/v1/machines/machine-1') return Response.json({ machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' }) });
      return null;
    } });
  const scope = { serverId: account.home.id, accountId: 'account-a' };
  storage.getState().applySettingsForScope(scope, settingsParse({ voice: {
    executionMachine: { mode: 'fixed', machineId: 'machine-1' },
  } }), 1);
  storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', installationId: 'installation-1', activeAt: Date.now() })], true,
    { sourceServerId: account.home.id });
  requests.length = 0;
  daemonResponse.mockReset();
  daemonResponse.mockImplementation(async method => {
    if (method === RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT) return inspection;
    if (method === RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_REQUEST) return requested;
    throw new Error(`Unexpected machine transport method: ${method}`);
  });
  permissionHttp.mockReset();
  permissionHttp.mockImplementation(async path => {
    if (path !== '/v1/plugins/permissions/grants/list') throw new Error(`Unexpected permission HTTP path: ${path}`);
    return Response.json({ grants: [], pendingRequests: [] });
  });
});
afterEach(async () => { await account?.dispose(); webLocks?.restore(); });

describe('raw credential authorization client', () => {
  it('calls inspect and request with the qualified contribution and exact raw tuple', async () => {
    const client = new RawCredentialAuthorizationClient();

    await expect(client.inspect(contribution, rawGrant)).resolves.toEqual(inspection);
    await expect(client.request(contribution, rawGrant)).resolves.toMatchObject({ pendingRequest: { id: 'request-1' } });
    expect(requests).toEqual([
      { method: `machine-1:${RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_INSPECT}`, params: { contribution, rawGrant } },
      { method: `machine-1:${RPC_METHODS.DAEMON_VOICE_CLIENT_RAW_CREDENTIAL_AUTHORIZATION_REQUEST}`, params: { contribution, rawGrant } },
    ]);
  });

  it('fails closed on malformed daemon output', async () => {
    daemonResponse.mockResolvedValue({ ok: true, authorization: { grants: [] } });
    const client = new RawCredentialAuthorizationClient();
    await expect(client.inspect(contribution, rawGrant)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('accepts an active grant for the exact daemon speech tuple', async () => {
    permissionHttp.mockResolvedValue(Response.json({ grants: [grant], pendingRequests: [] }));
    const actions = createPluginPermissionGrantActions({ execute: createPluginPermissionGrantHttpActionExecutor({ request: permissionHttp }) });
    await expect(inspectRawCredentialAuthorizationReadiness(
      contribution,
      rawGrant,
      undefined,
      { client: new RawCredentialAuthorizationClient(), list: actions.list },
    )).resolves.toBe('ready');
  });

  it('does not treat an authorization without an active exact grant as ready', async () => {
    permissionHttp.mockResolvedValue(Response.json({ grants: [
      PluginPermissionGrantV1Schema.parse({ ...grant, status: 'revoked', revokedAt: 3 }),
      PluginPermissionGrantV1Schema.parse({ ...grant, id: 'grant-another-installation',
        authoritySource: { kind: 'machine_installation', machineId: 'machine-1', installationId: 'installation-2' } }),
    ], pendingRequests: [] }));
    const actions = createPluginPermissionGrantActions({ execute: createPluginPermissionGrantHttpActionExecutor({ request: permissionHttp }) });
    await expect(inspectRawCredentialAuthorizationReadiness(
      contribution,
      rawGrant,
      undefined,
      {
        client: new RawCredentialAuthorizationClient(),
        list: actions.list,
      },
    )).resolves.toBe('approval_required');
  });
});
