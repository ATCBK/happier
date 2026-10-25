import 'fake-indexeddb/auto';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { SessionSpawnNewInputV2Schema, createAccountScopedCryptoMaterialSnapshotV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1, type AccountEncryptionCurrentnessResponse, type SessionSpawnNewInputV2, type SessionSpawnNewResultV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import { createDeferred, createPlainAccountEncryptionCurrentnessFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExistingSessionDirectoryPreflightResult, createPlainSessionCurrentProjectionRecordFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { PENDING_INPUT_PROTOCOL_VERSION_V4 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { DEFAULT_SESSION_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/sessionCapabilities';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSocketIoBoundaryStub } from '@/dev/testkit/mocks/socketIo';
import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';

import type { SavedSecretReferenceResolution } from '@/sync/store/settings/savedSecretCatalogSnapshot';

import { installNewSessionScreenModelCommonModuleMocks, selectNewSessionTestHome } from './newSessionScreenModelTestHelpers';

/** No Saved Secret is bound in these daemon-availability cases, so every ref resolves as deleted. */
const resolveSavedSecretReference = (ref: string): SavedSecretReferenceResolution => ({
  ref,
  kind: 'personal',
  status: 'deleted',
  entry: null,
  secret: null,
  revision: null,
  fingerprint: null,
});


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const socketRpcBoundary = vi.hoisted(() => ({
  respond: null as ((method: string, input: unknown) => Promise<unknown>) | null,
}));
vi.mock('socket.io-client', () => ({ io: () => {
  const boundary = createSocketIoBoundaryStub();
  boundary.socket.emitWithAck.mockImplementation(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string') throw new Error('Invalid test RPC payload');
    if (!socketRpcBoundary.respond) throw new Error('Test RPC boundary is not prepared');
    return { ok: true, result: await socketRpcBoundary.respond(payload.method.slice(payload.method.indexOf(':') + 1), 'params' in payload ? payload.params : undefined) };
  });
  return boundary.socket;
} }));

const syncSingletonBridge = vi.hoisted(() => ({
  current: null as typeof import('@/sync/sync').sync | null,
}));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
  getSyncSingleton: () => {
    if (!syncSingletonBridge.current) throw new Error('Test Sync singleton is not loaded');
    return syncSingletonBridge.current;
  },
}));

function spawnSuccess(sessionId: string): Extract<SessionSpawnNewResultV1, { type: 'success' }> {
  return {
    type: 'success',
    disposition: 'created',
    sessionId,
    executionTarget: { serverId: 'server-a', machineId: 'm1' },
    organizationPlacement: { folderId: null, tagIds: [] },
    initialInput: { status: 'accepted', localId: `input-${sessionId}` },
  };
}

function readDraftComposerText(snapshot: import('@/sync/ops/sessionDrafts/sessionDraftRepository').SessionDraftSnapshot | null) {
  if (!snapshot) return undefined;
  if (!('composer' in snapshot.document)) throw new Error('Expected a composer draft');
  return snapshot.document.composer.text.value;
}

async function expectSubmittedDraftRetired(scope: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope, draftId: string) {
  const { getSessionDraftSnapshot, listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
  expect(listNewSessionDraftProjections(scope).map(draft => draft.draftId)).not.toContain(draftId);
  const retained = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
  // Local supplements may retain an unmaterialized scratch document after clearing.
  if (!retained) return;
  expect(retained.materialized).toBe(false);
  if (retained.document.target.kind !== 'newSession') throw new Error('Expected New Session draft');
  expect(retained.document.target.authoring).toEqual({});
  expect(readDraftComposerText(retained)).toBe('');
  if (!('composer' in retained.document)) throw new Error('Expected draft composer');
  expect(retained.document.composer.mentions.value).toEqual([]);
  expect(retained.document.composer.attachments.value).toEqual([]);
  expect(retained.localSupplement.launchUserAttemptId).toBeUndefined();
  expect(retained.localSupplement.launchCurrentnessCapture).toBeUndefined();
}

async function createHarness() {
  const additionalBoundary = {
    http: null as ((url: URL, init?: RequestInit) => Promise<Response | null>) | null,
    rpc: null as ((method: string, input: unknown) => Promise<unknown | undefined>) | null,
  };
  const plainCurrentness = createPlainAccountEncryptionCurrentnessFixture();
  const todoKv = {
    currentness: plainCurrentness as AccountEncryptionCurrentnessResponse,
    items: new Map<string, { key: string; value: string; version: number }>(),
    failWrite: false,
    conflictOnce: false,
    writes: [] as Array<{ key: string; value: string | null; version: number }>,
  };
  const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
  const sessionSpawnNewActionBoundarySpy = vi.fn(async (_input: SessionSpawnNewInputV2): Promise<SessionSpawnNewResultV1> => ({
    type: 'error',
      code: 'machine_offline',
      retryable: true,
  }));
  installNewSessionScreenModelCommonModuleMocks({
    text: () =>
      createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
          if (key === 'status.lastSeen') return `status.lastSeen:${String(params?.time ?? '')}`;
          if (key === 'time.minutesAgo') return `time.minutesAgo:${String(params?.count ?? '')}`;
          if (key === 'time.hoursAgo') return `time.hoursAgo:${String(params?.count ?? '')}`;
          if (key === 'errors.errorWithCode') return `${key}:${String(params?.code ?? '')}:${String(params?.message ?? '')}`;
          return key;
        },
      }),
    modal: async () => ({
      Modal: { alert: modalAlertSpy, confirm: vi.fn(async () => false) },
    }),
  });
  vi.doUnmock('@/sync/domains/state/storage');
  vi.doUnmock('@/sync/domains/state/persistence');
  await selectNewSessionTestHome();
  const { storage } = await import('@/sync/domains/state/storageStore');
  storage.getState().activateProfileScope({ serverId: 'server-a', accountId: 'account-a' });
  storage.getState().activateSettingsScope({ serverId: 'server-a', accountId: 'account-a' });
  storage.getState().applySettings(storage.getState().settings, 1);
  storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
  vi.spyOn(storage.getState(), 'upsertPendingMessage');
  vi.spyOn(storage.getState(), 'markSessionOptimisticThinking');




  // Keep Action dispatch and local launch custody real; replace only daemon transport.
  const { apiSocket } = await import('@/sync/api/session/apiSocket');
  const respondMachineRpc = async (method: string, input: unknown) => {
    const additional = await additionalBoundary.rpc?.(method, input);
    if (additional !== undefined) return additional;
    if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) return createExistingSessionDirectoryPreflightResult(input);
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
        codex: { id: 'codex', title: 'Codex', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
      } } };
    }
    if (method === RPC_METHODS.CAPABILITIES_INVOKE) {
      return { protocolVersion: 1, ok: true, result: { source: 'static', configOptions: [
        { id: 'codexBackendMode', name: 'Runtime', type: 'select', options: [{ name: 'App server', value: 'appServer' }] },
      ] } };
    }
    if (method !== RPC_METHODS.SESSION_SPAWN_NEW) return { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
    return await sessionSpawnNewActionBoundarySpy(SessionSpawnNewInputV2Schema.parse(input));
  };
  socketRpcBoundary.respond = respondMachineRpc;
  const machineRpcSpy = vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async (_machineId, method, input, options) => {
    options?.onIssued?.();
    return await respondMachineRpc(method, input);
  });
  const { sync } = await import('@/sync/syncEngine');
  syncSingletonBridge.current = sync;
  const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
  let authProjection: Awaited<ReturnType<typeof renderScreen>> | null = null;
  const authoringMemoryHttp = createAuthoringMemoryHttpBoundary();
  const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
  const fetchBoundary = createSessionReadBatchFetchBoundary(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const memory = await authoringMemoryHttp.handle(input, init);
    if (memory) return memory;
    const url = String(input instanceof Request ? input.url : input);
    const additional = await additionalBoundary.http?.(new URL(url), init);
    if (additional) return additional;
    const bootstrap = createEmptyAccountBootstrapHttpResponse(new URL(url).pathname, init);
    if (bootstrap) return bootstrap;
    if (url.includes('/v1/kv/')) {
      const key = decodeURIComponent(url.split('/v1/kv/')[1]!);
      const row = todoKv.items.get(key);
      return row ? Response.json(row) : Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (url.endsWith('/v1/kv') && init?.method === 'POST') {
      const { mutations } = JSON.parse(String(init.body)) as { mutations: typeof todoKv.writes };
      todoKv.writes.push(...mutations);
      if (todoKv.failWrite) return Response.json({ error: 'task link unavailable' }, { status: 400 });
      if (todoKv.conflictOnce) {
        todoKv.conflictOnce = false;
        const row = todoKv.items.get(mutations[0]!.key)!;
        const { decodeBase64StoredJsonContentEnvelope, encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
        const envelope = decodeBase64StoredJsonContentEnvelope(row.value);
        if (envelope?.t !== 'plain') throw new Error('Plain conflict fixture expected');
        const item = envelope.v as Record<string, unknown>;
        row.value = encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { ...item, linkedSessions: { ...(item.linkedSessions as object), concurrent: { title: 'Another session', linkedAt: 2 } } } });
        row.version += 1;
      }
      const errors = mutations.flatMap((mutation) => {
        const row = todoKv.items.get(mutation.key);
        return row?.version === mutation.version ? [] : [{ key: mutation.key, error: 'version-mismatch', version: row?.version ?? -1, value: row?.value ?? null }];
      });
      if (errors.length > 0) return Response.json({ success: false, errors }, { status: 409 });
      const results = mutations.map((mutation) => {
        const version = mutation.version + 1;
        if (mutation.value === null) todoKv.items.delete(mutation.key);
        else todoKv.items.set(mutation.key, { key: mutation.key, value: mutation.value, version });
        return { key: mutation.key, version };
      });
      return Response.json({ success: true, results });
    }
    if (url.endsWith('/v1/account/encryption/currentness')) return Response.json(todoKv.currentness);
    if (url.endsWith('/v1/account/encryption')) return Response.json({ mode: todoKv.currentness.mode, updatedAt: 1 });
    if (url.endsWith('/v2/account/settings')) return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
    if (new URL(url).pathname === '/v1/machines/read-batch' && init?.method === 'POST') {
      return createMachineReadBatchResponseFixture(init.body, id => createPlainMachineRowFixture({ id, accountId: 'account-a' }));
    }
    const machineId = new URL(url).pathname.match(/^\/v1\/machines\/([^/]+)(?:\/access)?$/)?.[1];
    if (machineId && !url.endsWith('/access')) return Response.json({ machine: createPlainMachineRowFixture({ id: machineId, accountId: 'account-a' }) });
    // Session creation reads current Machine custody through the real HTTP owner.
    if (machineId && url.endsWith('/access')) return Response.json(MachineAccessGrantsListResponseV1Schema.parse({
      machineId, custodian: { accountId: 'account-a', displayName: 'Test Account' },
      access: { custodian: { accountId: 'account-a', displayName: 'Test Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
      canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }));
    if (/^\/v1\/sessions\/[^/]+\/messages$/.test(new URL(url).pathname)) {
      return Response.json({ messages: [], hasMore: false });
    }
    const sessionId = new URL(url).pathname.match(/^\/v2\/sessions\/([^/]+)$/)?.[1];
    if (sessionId) {
      const session = storage.getState().sessions[decodeURIComponent(sessionId)];
      if (!session) return Response.json({ error: 'unavailable' }, { status: 503 });
      return Response.json({ session: {
        id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
        active: session.active, activeAt: session.activeAt, encryptionMode: session.encryptionMode,
        dataEncryptionKey: null, metadataLayoutVersion: 0, metadataVersion: session.metadataVersion,
        metadata: JSON.stringify(session.metadata), agentStateVersion: session.agentStateVersion,
        agentState: session.agentState === null ? null : JSON.stringify(session.agentState), share: null,
      } });
    }
    if (url.endsWith('/health') || url.endsWith('/v1/auth/ping')) return Response.json({ ok: true });
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`;
  vi.spyOn(sync, 'sendMessage');
  await import('@/sync/ops/actions/defaultActionExecutor');

  const { useCreateNewSession: useCreateNewSessionOwner } = await import('./useCreateNewSession');
  const useCreateNewSession: typeof useCreateNewSessionOwner = (params) => useCreateNewSessionOwner({
    ...params,
    draftScope: params.draftScope ?? { serverId: 'server-a', accountId: 'account-a' },
  });
  const initialStore = storage.getState();
  return {
    async reset() {
      await authProjection?.unmount();
      authProjection = null;
      todoKv.currentness = plainCurrentness;
      todoKv.items.clear();
      todoKv.failWrite = false;
      todoKv.conflictOnce = false;
      todoKv.writes = [];
      additionalBoundary.http = null;
      additionalBoundary.rpc = null;
      modalAlertSpy.mockClear();
      machineRpcSpy.mockClear();
      sessionSpawnNewActionBoundarySpy.mockReset().mockResolvedValue({ type: 'error', code: 'machine_offline', retryable: true });
      storage.setState({ ...initialStore, sessions: {}, sessionPending: {} });
      const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
      actionOperationStore.reset();
      authoringMemoryHttp.reset();
      setRuntimeFetch(fetchBoundary);
      vi.stubGlobal('fetch', fetchBoundary);
      await selectNewSessionTestHome();
      // The package harness clears browser storage before each test. Restore
      // credentials through its real owner before Account-scoped Action reads.
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
      await TokenStorage.setCredentialsForServerUrl('https://server-a', { serverId: getActiveServerSnapshot().serverId }, { token });
      await sync.switchServer({ token });
      // Sync credentials alone do not authenticate the rendered UI. Let the
      // real auth projection supply the Action owner's credential provenance.
      authProjection = await renderScreen(React.createElement(InjectedAuthProvider, { credentials: { token }, children: null }));
      storage.getState().applySettings(storage.getState().settings, 1);
      storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: 'server-a' });
    },
    useCreateNewSession,
    modalAlertSpy,
    sessionSpawnNewActionBoundarySpy,
    todoKv,
    machineRpcSpy,
    additionalBoundary,
    async disposeAuth() { await authProjection?.unmount(); authProjection = null; },
    get storageState() { return storage.getState(); },
  };
}

// Load the real cold module graph during collection; setup's budget observes
// Account/HTTP/draft hydration, not compilation of the Action executor graph.
const harness = await createHarness();
// Call-through observation only: keep the real Action owner and returned values.
const spawnActionObservation = vi.spyOn(await import('@/sync/ops/actions/sessionSpawnNewAction'), 'executeSessionSpawnNewAction');
const scopedTransportObservation = vi.spyOn(await import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport'), 'resolveServerScopedTransport');
// The composed cold graph belongs to collection, like the Action graph above;
// per-test time observes the journey, rather than compiling its UI owners.
const approvalAttachmentModules = await Promise.all([
  import('./screenModel/useNewSessionActionOperationReconciliation'),
  import('../attachments/useNewSessionAttachmentsController'),
  import('./screenModel/useNewSessionComposerDocument'),
  import('@/dev/testkit/harness/artifactStoreBoundary'),
  import('@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption'),
]);
let actionHomesBoundary: Awaited<ReturnType<typeof serveActionHomes>>;
let browserStorageBoundary: ReturnType<typeof installLocalStorageMock>;
let approvalAttachmentCase = 0;
async function setupHarness() {
  await harness.reset();
  return harness;
}

async function setupTaskHarness(options: Readonly<{ httpsHome?: boolean }> = {}) {
  // The real cold connection owner awaits its initial-sync budget. Frozen timers
  // cannot settle that budget when unrelated bootstrap endpoints are unavailable.
  vi.useRealTimers();
  const result = await setupHarness();
  let homeConnectionDescriptor: import('@happier-dev/protocol').HomeConnectionDescriptorV1 | undefined;
  if (options.httpsHome) {
    const { HomeConnectionDescriptorV1Schema } = await import('@happier-dev/protocol/auth/accountDirectory');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { adoptHomeProfile, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const profile = getServerProfileById(getActiveServerSnapshot().serverId);
    if (!profile) throw new Error('The synthetic Home must exist before descriptor adoption');
    homeConnectionDescriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1,
      homeServerIdentityId: profile.serverIdentityId ?? 'srv_approval_fixture', canonicalServerUrl: profile.serverUrl,
      revision: (profile.homeConnectionDescriptor?.revision ?? 0) + 1,
      endpoints: [{ kind: 'https', url: profile.serverUrl }],
    });
    await adoptHomeProfile({ source: 'manual', descriptor: homeConnectionDescriptor });
  }
  const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
  // reset() already initialized Sync. Apply descriptor adoption through the
  // warm switch owner so it rebinds the Account scope as well as the carrier.
  await switchConnectionToActiveServer();
  const { storage } = await import('@/sync/domains/state/storageStore');
  const scope = storage.getState().profileScope!;
  if (options.httpsHome) {
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    expect(await resolveServerCredentialAccountScope(scope.serverId)).toMatchObject({ kind: 'bound', scope });
  }
  storage.getState().applySettings(storage.getState().settings, 1);
  storage.getState().applyMachines([createMachineFixture({ id: 'm1' })], true, { sourceServerId: scope.serverId });
  // Accepted creation also hydrates the destination through the real request
  // owner. Keep its propagation/recovery timers running through completion.
  return { ...result, scope, homeConnectionDescriptor, get storageState() { return storage.getState(); } };
}

type CreateSessionParams = Parameters<(typeof import('./useCreateNewSession'))['useCreateNewSession']>[0];

function createRetryParams(settings: Settings, overrides: Partial<CreateSessionParams> = {}): CreateSessionParams {
  return {
    launchIntentSignature: 'test-launch-intent',
    router: { push: vi.fn(), replace: vi.fn() },
    selectedMachineId: 'm1',
    selectedMachine: createMachineFixture({ id: 'm1' }),
    selectedPath: '/tmp',
    draftScope: { serverId: 'server-a', accountId: 'account-a' },
    targetServerId: 'server-a',
    allowedTargetServerIds: ['server-a'],
    setIsCreating: vi.fn(),
    setIsResumeSupportChecking: vi.fn(),
    useProfiles: false,
    selectedProfileId: null,
    profileMap: new Map(),
    recentMachinePaths: [],
    agentType: 'codex',
    permissionMode: 'default',
    modelMode: 'default',
    promptStore: createNewSessionPromptStore(''),
    resumeSessionId: '',
    agentNewSessionOptions: null,
    machineEnvPresence: { isPreviewEnvSupported: false, isLoading: false, meta: {}, refreshedAt: null, refresh: () => {} },
    secrets: [],
    secretBindingsByProfileId: {},
    selectedSecretIdByProfileIdByEnvVarName: {},
    resolveSavedSecretReference,
    sessionOnlySecretValueByProfileIdByEnvVarName: {},
    selectedMachineCapabilities: {},
    ...overrides,
  };
}

function alertRetry(modalAlertSpy: Awaited<ReturnType<typeof setupHarness>>['modalAlertSpy']): () => void {
  const buttons = modalAlertSpy.mock.calls.at(-1)?.[2] as ReadonlyArray<{ text: string; onPress?: () => void }> | undefined;
  const retry = buttons?.find((button) => button.text === 'common.retry')?.onPress;
  expect(retry).toBeTypeOf('function');
  return retry!;
}

async function setupApprovalAttachmentLaunch() {
  let phase = 'restore Account';
  const observedHttpPaths: string[] = [];
  const observedRpcMethods: string[] = [];
  onTestFailed(() => console.error('Attachment approval phase:', phase, 'HTTP paths:', [...new Set(observedHttpPaths)], 'RPC methods:', [...new Set(observedRpcMethods)]));
  const context = await setupTaskHarness({ httpsHome: true });
  spawnActionObservation.mockClear();
  scopedTransportObservation.mockClear();
  const actionFailures = async () => {
    const firstLine = (message: string) => message.split('\n')[0]!.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/header\.[\w-]+\.signature/g, '[redacted]');
    const results = await Promise.allSettled(spawnActionObservation.mock.results.map(result => result.value));
    return results.flatMap(result => result.status === 'fulfilled'
      ? result.value?.ok === false ? [{ code: result.value.errorCode, message: firstLine(result.value.error) }] : []
      : [{ code: 'thrown', message: result.reason instanceof Error ? firstLine(result.reason.message) : 'unknown' }]);
  };
  const transportObservations = async () => {
    const results = await Promise.allSettled(scopedTransportObservation.mock.results.map(result => result.value));
    const fact = (value: unknown) => typeof value === 'string' || typeof value === 'boolean' ? value : undefined;
    return scopedTransportObservation.mock.calls.map(([input], index) => {
      const descriptor = input.profile.homeConnectionDescriptor;
      const result = results[index];
      return { serverUrl: input.profile.serverUrl, canonicalServerUrl: input.profile.canonicalServerUrl,
        descriptorHomeId: descriptor?.homeServerIdentityId,
        endpoints: descriptor?.endpoints.map(endpoint => ({ kind: endpoint.kind,
          status: fact(Reflect.get(endpoint, 'status')), verified: fact(Reflect.get(endpoint, 'verified')),
          verification: fact(Reflect.get(endpoint, 'verification')) })),
        ...(result?.status === 'fulfilled' ? { carrier: result.value.carrier }
          : { refusal: result?.status === 'rejected' && result.reason instanceof Error ? result.reason.message.split('\n')[0] : 'unknown' }),
      };
    });
  };
  const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
  const profile = getServerProfileById(context.scope.serverId);
  if (!profile) throw new Error('The adopted synthetic Home must remain addressable');
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = await TokenStorage.getCredentialsForServerUrl(profile.serverUrl);
  if (!credentials) throw new Error('The adopted synthetic Home must retain its Account credentials');
  const { resolveServerScopedTransport } = await import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedTransport');
  const transport = await resolveServerScopedTransport({ profile, credentials });
  expect(transport.carrier, JSON.stringify({ endpointKinds: profile.homeConnectionDescriptor?.endpoints.map(endpoint => endpoint.kind),
    descriptorProvenance: profile.descriptorProvenance ?? 'established' })).toBe('https');
  await transport.release();
  phase = 'load composed owners';
  const { storage } = await import('@/sync/domains/state/storageStore');
  const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
  const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol/features/serverEnabledBit');
  const { getReadyServerFeatures } = await import('@/sync/api/capabilities/getReadyServerFeatures');
  const [
    { useNewSessionActionOperationReconciliation },
    { useNewSessionAttachmentsController },
    { useNewSessionComposerDocument },
    { createArtifactStoreBoundary },
    { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope },
  ] = approvalAttachmentModules;
  const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
  const { encodePlainArtifactStoredContent } = await import('@happier-dev/protocol/storage/artifactStoredContent');
  const { encodePlainMachineStoredContent } = await import('@happier-dev/protocol/machines/machineStoredContent');
  const { buildApprovalRequestArtifactHeaderV1, ApprovalRequestV2Schema } = await import('@happier-dev/protocol');
  const { PreparedTransferRpcRequestV1Schema } = await import('@happier-dev/protocol/machines/transfer/preparedTransferRpcV1');
  const { writeNewSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
  const { writeNewSessionAttachmentDrafts, readNewSessionAttachmentDrafts } = await import('@/components/sessions/new/attachments/newSessionAttachmentDraftStore');
  const draftId = `approval-attachment-draft-${++approvalAttachmentCase}`;
  const flowId = `approval-attachment-flow-${context.scope.serverId}-${approvalAttachmentCase}`;
  const selectedPath = `/tmp/${draftId}`;
  const promptStore = createNewSessionPromptStore('Inspect the attached note');
  writeNewSessionDraft({ scope: context.scope, draftId, patch: { text: promptStore.getPrompt() }, materializationIntent: 'userEdit' });
  writeNewSessionAttachmentDrafts(flowId, [{ id: 'note-file', source: { kind: 'memory', name: 'note.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('hello') }, status: 'pending' }]);
  const features = createRootLayoutFeaturesResponse({ homeConnectionDescriptor: context.homeConnectionDescriptor,
    capabilities: { serverIdentity: { serverIdentityId: context.homeConnectionDescriptor!.homeServerIdentityId },
      session: { ...DEFAULT_SESSION_CAPABILITIES, pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } },
      server: { canonicalServerUrl: profile.serverUrl } } });
  if (!tryWriteServerEnabledBitInPlace(features, 'machines.transfer', true)) throw new Error('Missing Machine transfer feature');
  if (!tryWriteServerEnabledBitInPlace(features, 'attachments.uploads', true)) throw new Error('Missing attachment upload feature');
  const actionsSettingsV1 = normalizeActionsSettingsV1({ v: 1, actions: { 'session.spawn_new': { approvalRequiredSurfaces: ['ui'] } } });
  const settingsSnapshot = { ...storage.getState().settings, actionsSettingsV1, experiments: true,
    featureToggles: { ...storage.getState().settings.featureToggles, 'attachments.uploads': true } };
  storage.getState().applySettingsLocal(settingsSnapshot);
  const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => context.scope.accountId, encryptionMode: 'plain' });
  const uploadedBytes: number[] = [];
  const submittedMessages: unknown[] = [];
  const recipient = createTransferRecipientKeyPair();
  const machine = createMachineFixture({ id: 'm1', daemonState: { status: 'running', transfer: {
    supported: { import: true, export: true },
    listenerClasses: { loopback_http: { enabled: false, configured: false, active: false }, tailscale_serve_https: { enabled: false, configured: false, active: false } },
    lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
  } } });
  const machineRow = { ...createPlainMachineRowFixture({ id: 'm1', accountId: context.scope.accountId }),
    metadata: encodePlainMachineStoredContent(machine.metadata), daemonState: encodePlainMachineStoredContent(machine.daemonState) };
  const approvedSessionRecord = () => createPlainSessionCurrentProjectionRecordFixture({ id: 'approved-note-session',
    metadata: { path: selectedPath, host: 'test', machineId: 'm1' } });
  context.additionalBoundary.http = async (url, init) => {
    observedHttpPaths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    const artifactResponse = await artifacts.handle(`${url.pathname}${url.search}`, init);
    if (artifactResponse) return artifactResponse;
    if (url.pathname === '/v1/features' || url.pathname === '/v1/features/authenticated') return Response.json(features);
    if (url.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settingsSnapshot }, version: 1 });
    if (url.pathname === '/v1/machines') return Response.json([machineRow]);
    if (url.pathname === '/v1/machines/m1') return Response.json({ machine: machineRow });
    // /active is a list resource, not a Session id. The generic detail fixture
    // would otherwise answer 503 and mark this healthy synthetic Home offline.
    if (url.pathname === '/v2/sessions/active') return Response.json(V2SessionListResponseSchema.parse({
      sessions: storage.getState().sessions['approved-note-session'] ? [approvedSessionRecord()] : [],
      nextCursor: null, hasNext: false,
    }));
    if (url.pathname === '/v2/sessions/approved-note-session') return Response.json({
      session: approvedSessionRecord(),
    });
    if (url.pathname.endsWith('/pending') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { localId: string; requestedAction: unknown; content: unknown };
      submittedMessages.push(body);
      return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId }, didWrite: true });
    }
    if (url.pathname.endsWith('/pending')) return Response.json({ pending: [], pendingCount: 0 });
    return null;
  };
  phase = 'admit server features';
  await getReadyServerFeatures({ serverId: context.scope.serverId, force: true });
  storage.getState().applyMachines([machine], true, { sourceServerId: context.scope.serverId });
  context.additionalBoundary.rpc = async (method, input) => {
    observedRpcMethods.push(method);
    if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE) return {
      success: true, uploadId: 'approval-note-upload', destDisplayPath: '.happier/uploads/note.txt', expectedSizeBytes: 5,
      chunkSizeBytes: 2, recipientPublicKeyBase64: recipient.recipientPublicKeyBase64, expiresAt: Date.now() + 60_000,
      endpointCandidates: [{ kind: 'http', url: 'http://127.0.0.1:48123/machine-transfers/direct/imports/approval-note-upload', expiresAt: Date.now() + 60_000 }],
    };
    if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK) {
      const phase = PreparedTransferRpcRequestV1Schema.parse(input);
      const index = Number(phase.path.split('/').at(-1));
      const chunk = phase.body;
      if (!chunk || typeof chunk !== 'object' || !('payloadBase64' in chunk) || !('encryptedDataKeyEnvelopeBase64' in chunk)
        || typeof chunk.payloadBase64 !== 'string' || typeof chunk.encryptedDataKeyEnvelopeBase64 !== 'string') throw new Error('Invalid encrypted upload chunk');
      uploadedBytes.push(...await decryptEncryptedTransferChunkEnvelope({ transferId: 'approval-note-upload', sequence: index,
        payloadBase64: chunk.payloadBase64, encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64, recipientSecretKeySeed: recipient.recipientSecretKeySeed }));
      return { status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) };
    }
    if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) return { status: 200, contentType: 'application/json', body: JSON.stringify({ success: true,
      finalized: { success: true, path: '.happier/uploads/note.txt', sizeBytes: 5 }, sha256: 'note-sha256' }) };
    if (method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT) return { success: true, aborted: true };
    return undefined;
  };
  let requestId: string | null = null;
  const settlement = vi.fn();
  const router = { push: vi.fn(), replace: vi.fn() };
  const disableDraftPersistence = vi.fn();
  const emptyAttachments: readonly import('@happier-dev/protocol').ComposerAttachmentDraftV1[] = [];
  const emptyEntries = {};
  const canSubmitRef = { current: true };
  let creationSettled = false;
  phase = 'render composed owners';
  const hook = await renderHook(() => {
    const [isCreating, setIsCreating] = React.useState(false);
    const [launchRequestId, setLaunchRequestId] = React.useState<string | null>(null);
    const reconciliation = useNewSessionActionOperationReconciliation({ draftId, draftScope: context.scope, requestId: launchRequestId,
      localCreationInFlight: isCreating, disableDraftPersistence, resetLaunchRequestId: setLaunchRequestId, router });
    const composerDocument = useNewSessionComposerDocument({ draftId, draftScope: context.scope, promptStore,
      persistedAttachments: emptyAttachments, composerAttachmentEntriesById: emptyEntries,
      scopeKey: `approval:${context.scope.serverId}:${context.scope.accountId}`, canSubmitRef, isSubmitting: isCreating });
    const creator = context.useCreateNewSession(createRetryParams(storage.getState().settings, {
      draftId, draftScope: context.scope, targetServerId: context.scope.serverId, allowedTargetServerIds: [context.scope.serverId],
      launchIntentSignature: draftId,
      selectedPath,
      selectedMachine: machine, promptStore, router, setIsCreating,
      onLaunchUserAttemptIdChange: id => { requestId = id; setLaunchRequestId(id); },
      onLaunchApprovalPending: reconciliation.launchApproval.request,
    }));
    const attachments = useNewSessionAttachmentsController({ flowId, isCreating, promptStore,
      selectedProfileId: null, selectedMachineId: 'm1', targetServerId: context.scope.serverId, selectedPath, composerDocument,
      handleCreateSession: opts => {
        creator.handleCreateSession({ ...opts, onAfterCreatedSettled: value => {
          creationSettled = true;
          settlement(value);
          opts?.onAfterCreatedSettled?.(value);
        } });
      },
    });
    return { attachments, reconciliation, composerDocument, isCreating };
  });
  phase = 'submit attachment';
  await act(async () => {
    hook.getCurrent().attachments.handleSend();
    await flushHookEffects({ cycles: 8, turns: 4 });
  });
  phase = 'await real Ask Artifact';
  await vi.waitFor(async () => expect(artifacts.list().length, JSON.stringify({
    actionFailures: await actionFailures(),
    transportObservations: await transportObservations(),
    alerts: context.modalAlertSpy.mock.calls,
    rpcMethods: context.machineRpcSpy.mock.calls.map(call => call[1]),
    documentAvailable: hook.getCurrent().composerDocument.readCurrentDocumentSnapshot() !== null,
    attachmentsEnabled: hook.getCurrent().attachments.attachmentsUploadsEnabled,
    endpoint: { status: storage.getState().endpointStatus, reason: storage.getState().endpointReason,
      message: storage.getState().endpointLastErrorMessage },
  })).toBe(1));
  const artifactId = artifacts.list()[0]!.id;
  const publishApproval = async (status: 'open' | 'executed' | 'rejected' | 'canceled') => {
    phase = `observe ${status} approval`;
    const original = ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!));
    if (!requestId || original.executionOriginV1.requestId !== requestId) throw new Error('Approval must retain the actual submitted request');
    const request = ApprovalRequestV2Schema.parse({ ...original, status, updatedAtMs: Date.now(),
      ...(status === 'executed' ? { decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 2, ok: true,
        result: { ...spawnSuccess('approved-note-session'), executionTarget: { serverId: context.scope.serverId, machineId: 'm1' }, initialInput: { status: 'notRequested' } } } } : {}),
      ...(status === 'rejected' ? { decision: { kind: 'reject', decidedAtMs: 2 } } : {}),
    });
    const stored = artifacts.read(artifactId)!;
    artifacts.replaceStoredRow({ ...stored, header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }), headerVersion: status === 'open' ? 1 : 2,
      bodyVersion: status === 'open' ? 1 : 2, updatedAt: Date.now() });
    await act(async () => {
      if (status === 'executed') storage.getState().applySessions([createSessionFixture({ id: 'approved-note-session', serverId: context.scope.serverId,
        metadata: { path: selectedPath, host: 'test', machineId: 'm1' }, encryptionMode: 'plain' })]);
      storage.getState().updateArtifact({ id: artifactId, title: null, header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
        headerVersion: status === 'open' ? 1 : 2, bodyVersion: status === 'open' ? 1 : 2, seq: 1, createdAt: 1, updatedAt: Date.now(), isDecrypted: true });
      await flushHookEffects({ cycles: 8, turns: 4 });
    });
  };
  await publishApproval('open');
  phase = 'approval pending';
  return { ...context, artifactId, hook, settlement, router, uploadedBytes, submittedMessages, publishApproval, observedRpcMethods,
    draftSnapshot: () => getSessionDraftSnapshot(context.scope, { kind: 'newSession', draftId }),
    fileDrafts: () => readNewSessionAttachmentDrafts(flowId),
    get creationSettled() { return creationSettled; },
    waitForCreation: async () => {
      await vi.waitFor(() => expect(creationSettled, JSON.stringify({ phase, uploadedBytes: uploadedBytes.length,
        submittedMessages: submittedMessages.length, settlements: settlement.mock.calls, alerts: context.modalAlertSpy.mock.calls,
        rpcMethods: context.machineRpcSpy.mock.calls.map(call => call[1]) })).toBe(true));
    },
  };
}

describe('useCreateNewSession (daemon unavailable UX)', () => {
  beforeAll(async () => {
    // beforeAll precedes the package's per-test browser Storage installation.
    browserStorageBoundary = installLocalStorageMock();
    actionHomesBoundary = await serveActionHomes({ homes: [{ key: 'task', serverUrl: 'https://server-a', accountId: 'account-a' }], route: () => undefined });
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
  });
  afterAll(async () => {
    await actionHomesBoundary?.dispose();
    browserStorageBoundary?.restore();
    syncSingletonBridge.current = null;
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    // Launches use real asynchronous batch dispatch; only the asserted clock is synthetic.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
  });

  afterEach(async () => {
    await standardCleanup();
    await harness?.disposeAuth();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('completes the retained attachment and first turn only after the launch approval executes', async () => {
    const launch = await setupApprovalAttachmentLaunch();
    expect(launch.hook.getCurrent().attachments.attachmentsUploadsEnabled).toBe(true);
    expect(launch.hook.getCurrent().reconciliation.launchApproval.pending?.artifactId).toBe(launch.artifactId);
    expect(launch.hook.getCurrent().isCreating, 'The retained local launch owns completion while approval is pending').toBe(true);
    expect(launch.creationSettled).toBe(false);
    expect(launch.settlement).not.toHaveBeenCalled();
    expect(launch.uploadedBytes).toEqual([]);
    expect(launch.submittedMessages).toEqual([]);
    expect(readDraftComposerText(launch.draftSnapshot())).toBe('Inspect the attached note');
    await launch.publishApproval('executed');
    await launch.waitForCreation();
    await vi.waitFor(() => expect(launch.settlement, JSON.stringify({ alerts: launch.modalAlertSpy.mock.calls,
      rpcMethods: launch.observedRpcMethods, uploadedBytes: launch.uploadedBytes.length,
      submittedMessages: launch.submittedMessages.length })).toHaveBeenCalledWith({ status: 'accepted', sessionId: 'approved-note-session' }));
    expect(launch.uploadedBytes).toEqual([...new TextEncoder().encode('hello')]);
    expect(launch.submittedMessages).toEqual([expect.objectContaining({ content: expect.objectContaining({
      t: 'plain', v: expect.objectContaining({
        content: { type: 'text', text: 'Inspect the attached note' },
        meta: expect.objectContaining({ happier: { kind: 'attachments.v1', payload: {
          attachments: [expect.objectContaining({ id: 'note-file', path: '.happier/uploads/note.txt', name: 'note.txt', sizeBytes: 5 })],
        } } }),
      }),
    }) })]);
    await vi.waitFor(() => expect(readDraftComposerText(launch.draftSnapshot()) ?? '').toBe(''));
    expect(launch.fileDrafts()).toEqual([]);
    // The approver already created the Session elsewhere; this origin never spawns it again.
    expect(launch.sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    await launch.hook.unmount();
  });

  it.each(['rejected', 'canceled'] as const)('keeps the submitted attachment draft after its launch approval is %s', async status => {
    const launch = await setupApprovalAttachmentLaunch();
    expect(launch.settlement).not.toHaveBeenCalled();
    await launch.publishApproval(status);
    await launch.waitForCreation();
    expect(launch.settlement).toHaveBeenCalledWith({ status: 'rejected' });
    expect(launch.uploadedBytes).toEqual([]);
    expect(launch.submittedMessages).toEqual([]);
    expect(readDraftComposerText(launch.draftSnapshot())).toBe('Inspect the attached note');
    expect(launch.fileDrafts()).toHaveLength(1);
    expect(launch.router.replace).not.toHaveBeenCalled();
    expect(launch.sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    await launch.hook.unmount();
  });

  it('releases the pending attachment launch when its original surface unmounts', async () => {
    const launch = await setupApprovalAttachmentLaunch();
    expect(launch.creationSettled).toBe(false);
    await launch.hook.unmount();
    await vi.waitFor(() => expect(launch.creationSettled).toBe(true));
    await launch.publishApproval('executed');
    expect(launch.uploadedBytes).toEqual([]);
    expect(launch.submittedMessages).toEqual([]);
    expect(readDraftComposerText(launch.draftSnapshot())).toBe('Inspect the attached note');
    expect(launch.fileDrafts()).toHaveLength(1);
    expect(launch.router.replace).not.toHaveBeenCalled();
    expect(launch.sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
  });

  it('commits submitted authoring before capturing launch revisions and keeps later edits after completion', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, scope } = await setupTaskHarness();
    const { writeNewSessionAuthoringDraftToRepository, readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
    const { writeNewSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftId = 'submitted-selections-draft';
    const submitted = {
      input: '', selectedMachineId: 'm1', selectedPath: '/submitted', targetServerId: scope.serverId,
      selectedProfileId: null, selectedSecretId: null, agentType: 'codex', permissionMode: 'read-only',
      modelSelection: { v: 1, ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5.5' }, updatedAt: 10 },
      acpSessionModeId: null, updatedAt: Date.now(),
    } satisfies import('@/sync/domains/state/persistence').NewSessionDraft;
    writeNewSessionDraft({ scope, draftId, patch: { text: 'Original draft' }, materializationIntent: 'userEdit' });
    writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: { ...submitted, selectedPath: '/older', permissionMode: 'default', modelSelection: null } });
    expect(readNewSessionDraftFromRepository({ scope, draftId })?.selectedPath).toBe('/older');
    const creation = createDeferred<void>();
    const enteredSpawn = createDeferred<void>();
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => {
      enteredSpawn.resolve(undefined);
      await creation.promise;
      harness.storageState.applySessions([createSessionFixture({ id: 'submitted-session', serverId: scope.serverId, encryptionMode: 'plain' })]);
      return { ...spawnSuccess('submitted-session'), executionTarget: { serverId: scope.serverId, machineId: 'm1' } };
    });
    const params = createRetryParams(storageState.settings, {
      draftId, draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      selectedPath: submitted.selectedPath, permissionMode: submitted.permissionMode,
      modelMode: submitted.modelSelection.ref.modelId,
      flushAuthoringDraft: () => writeNewSessionAuthoringDraftToRepository({ scope, draftId, draft: submitted }),
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    const settled = createDeferred<void>();
    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', onAfterCreatedSettled: () => settled.resolve(undefined) });
      await enteredSpawn.promise;
    });
    expect(readNewSessionDraftFromRepository({ scope, draftId })).toMatchObject({
      selectedPath: submitted.selectedPath, permissionMode: submitted.permissionMode, modelSelection: submitted.modelSelection,
    });
    // A later text edit is a successor, whereas the submitted selection fields
    // must be cleared with the accepted launch, not misclassified as successors.
    writeNewSessionDraft({ scope, draftId, patch: { text: 'Follow up after launch' }, materializationIntent: 'userEdit' });
    creation.resolve(undefined);
    // Acceptance is reported before the launch owner finishes revision-safe clearing.
    await act(async () => { await createPromise; });
    await settled.promise;
    const snapshot = getSessionDraftSnapshot(scope, { kind: 'newSession', draftId });
    expect(readDraftComposerText(snapshot)).toBe('Follow up after launch');
    if (snapshot?.document.target.kind !== 'newSession') throw new Error('Expected successor draft');
    expect(snapshot.document.target.authoring).not.toHaveProperty('directory');
    expect(snapshot.document.target.authoring).not.toHaveProperty('permissionMode');
    expect(snapshot.document.target.authoring).not.toHaveProperty('modelSelection');
    await hook.unmount();
  });

  it('ignores retired Zen launch metadata and leaves task links with the Tasks orchestrator', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, todoKv, scope } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    const { seedNewSessionDraftV1 } = await import('@/components/sessions/new/newSessionDraftSeed');
    const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
    const source = { kind: 'zen_task', taskId: 'task-1', scope, title: 'Fix task' } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    todoKv.items.set('todo.task-1', { key: 'todo.task-1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }), version: 1 });
    const draftId = seedNewSessionDraftV1({
      scope, seed: { prompt: { text: 'Fix task', mode: 'replace' },
        placement: { kind: 'exactTarget', serverId: scope.serverId, machineId: 'm1', directory: '/tmp' } },
      createDraftId: () => 'retired-task-draft',
    })!;
    storage.setState({ sessions: { ...storage.getState().sessions, 'task-session': createSessionFixture({ id: 'task-session', serverId: scope.serverId }) } });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ ...spawnSuccess('task-session'), executionTarget: { serverId: scope.serverId, machineId: 'm1' } });
    const params = createRetryParams(storageState.settings, {
      draftId, promptStore: createNewSessionPromptStore('Fix task'),
      draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      // Retained callers cannot revive the retired task-specific completion path.
      ...{ zenTaskSource: source }, targetAccountScope: scope,
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    const afterCreated = vi.fn(async () => {});
    await act(async () => { await hook.getCurrent().handleCreateSession({ afterCreated }); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(todoKv.writes).toEqual([]);
    expect(storage.getState().todoState!.todos['task-1']).not.toHaveProperty('linkedSessions');
    expect(afterCreated).toHaveBeenCalledTimes(1);
    await expectSubmittedDraftRetired(scope, draftId);
    await hook.unmount();
  });

  it('refuses a deleted task or a foreign Account/Home instead of recreating or retargeting it', async () => {
    const { todoKv, scope } = await setupTaskHarness();
    const { linkTaskToSession } = await import('@/sync/domains/todos/taskSessionLink');
    const source = { taskId: 'deleted', scope, title: 'Deleted task' } as const;
    const link = { source, session: { scope, sessionId: 'accepted-session' } };
    // The new link contract is an intent, not a replacement map.
    const linkIntent = linkTaskToSession;
    await expect(linkIntent(link)).rejects.toMatchObject({ code: 'task_deleted' });
    await expect(linkIntent({ ...link, source: { ...source, scope: { ...scope, accountId: 'foreign' } } })).rejects.toMatchObject({ code: 'task_scope_mismatch' });
    await expect(linkIntent({ ...link, source: { ...source, scope: { ...scope, serverId: 'foreign' } } })).rejects.toMatchObject({ code: 'task_scope_mismatch' });
    expect(todoKv.writes).toEqual([]);
  });

  it('retries a Temporary-computer follow-up without reviving retired task linking or another activation', async () => {
    const { useCreateNewSession, todoKv, scope, storageState, sessionSpawnNewActionBoundarySpy } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { seedNewSessionDraftV1 } = await import('@/components/sessions/new/newSessionDraftSeed');
    const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
    const { buildNewSessionAuthoringDraftFromResolvedInputs } = await import('@/components/sessions/authoring/draft/sessionAuthoringDraftAdapters');
    const source = { kind: 'zen_task', taskId: 'temporary-task', title: 'Temporary task', scope } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    const draftId = seedNewSessionDraftV1({ scope, seed: { prompt: { text: todo.title, mode: 'replace' } }, createDraftId: () => 'temporary-task-draft' })!;
    storage.setState({ sessions: { ...storage.getState().sessions, 'temporary-session': createSessionFixture({ id: 'temporary-session', serverId: scope.serverId }) } });
    const settlements: Array<import('./useCreateNewSession').TemporaryComputerCreatorSettlement> = [];
    const params = createRetryParams(storageState.settings, {
      draftScope: scope, draftId, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      temporaryComputerTargetScope: scope,
      ...{ zenTaskSource: source }, targetAccountScope: scope,
      authoringDraft: buildNewSessionAuthoringDraftFromResolvedInputs({
        executionTarget: { kind: 'temporary_computer', serverId: scope.serverId, artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } },
        directory: '', prompt: todo.title, connectedServices: null,
      }),
      // Remote activation settles later. Exercise the actual accepted-Session
      // settlement port rather than substituting completion or task logic.
      temporaryComputerLaunch: async (_submission, settlement) => { settlements.push(settlement); },
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    const afterCreated = vi.fn(async () => {}).mockRejectedValueOnce(new Error('follow_up_unavailable'));
    await act(async () => {
      await hook.getCurrent().handleCreateSession({
        afterCreated,
        temporaryComputerSubmission: {
          composer: {
            revision: 1, ref: { kind: 'newSession', instanceId: draftId }, text: todo.title,
            references: [], attachments: [], layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: { focused: false, editable: true, submittable: true, submitting: false, running: false },
          },
          reviewComments: null, attachmentDrafts: [],
          attachmentDestination: { uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads', vcsIgnoreStrategy: 'git_info_exclude', vcsIgnoreWritesEnabled: true },
          maxFileBytes: 1024,
        },
      });
    });
    expect(settlements).toHaveLength(1);
    await act(async () => {
      await expect(settlements[0]!.complete('temporary-session', [])).rejects.toMatchObject({ stage: 'follow_up' });
    });
    expect(readNewSessionDraftFromRepository({ scope, draftId })).not.toBeNull();
    expect(todoKv.writes).toEqual([]);
    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(readNewSessionDraftFromRepository({ scope, draftId })?.input).toBe(todo.title);
    await act(async () => { await settlements[0]!.complete('temporary-session', []); });
    expect(todoKv.writes).toEqual([]);
    await act(async () => { await settlements[0]!.complete('temporary-session', []); });
    expect(todoKv.writes).toEqual([]);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(settlements).toHaveLength(1);
    expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();
    // No successor edits exist, so acceptance retires the submitted authoring draft.
    await expectSubmittedDraftRetired(scope, draftId);
    await hook.unmount();
  });

  it('keeps same-id Sessions on different Homes distinct and makes repeated link acceptance a no-op', async () => {
    const { todoKv, scope } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    const { linkTaskToSession, getSessionsForTask } = await import('@/sync/domains/todos/taskSessionLink');
    const source = { taskId: 'task-1', scope, title: 'Task' } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    todoKv.items.set('todo.task-1', { key: 'todo.task-1', value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }), version: 1 });
    const input = { source, session: { scope, sessionId: 'same-id' } };
    const linkIntent = linkTaskToSession;
    await linkIntent(input);
    await linkIntent({ ...input, session: { scope: { serverId: 'server-b', accountId: 'account-b' }, sessionId: 'same-id' } });
    const before = todoKv.items.get('todo.task-1');
    const writeCount = todoKv.writes.length;
    await linkIntent(input);
    expect(todoKv.items.get('todo.task-1')).toEqual(before);
    expect(todoKv.writes).toHaveLength(writeCount);
    expect(getSessionsForTask('task-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...scope, sessionId: 'same-id' }),
      expect.objectContaining({ serverId: 'server-b', accountId: 'account-b', sessionId: 'same-id' }),
    ]));
  });

  it('links E2EE tasks with real Account crypto and rejects mode mismatches before writing', async () => {
    const { todoKv, scope } = await setupTaskHarness();
    const { sync } = await import('@/sync/syncEngine');
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { encodeBase64 } = await import('@/encryption/base64');
    const { resolveAccountScopedCryptoMaterialFromCredentials } = await import('@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials');
    const { encodeBase64StoredJsonContentEnvelope } = await import('@/sync/encryption/base64StoredJsonContent');
    const { linkTaskToSession, getSessionsForTask } = await import('@/sync/domains/todos/taskSessionLink');
    const credentials = { token: sync.getCredentials()!.token, secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: resolveAccountScopedCryptoMaterialFromCredentials(credentials) });
    todoKv.currentness = { mode: 'e2ee', version: 2, signingKeyFingerprint: 'signing-2', contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint), updatedAt: 2 };
    await sync.switchServer(credentials);
    const source = { taskId: 'e2ee-task', scope, title: 'Private task' } as const;
    const todo = { id: source.taskId, title: source.title, done: false, createdAt: 1, updatedAt: 1 };
    storage.getState().applyTodos({ todos: { [todo.id]: todo }, undoneOrder: [todo.id], doneOrder: [], versions: {} });
    // Raw ciphertext is the pinned 0.2-produced reader input; the real codec owns new writes.
    todoKv.items.set('todo.e2ee-task', { key: 'todo.e2ee-task', value: await sync.encryption!.encryptRaw(todo), version: 1 });
    await linkTaskToSession({ source, session: { scope, sessionId: 'private-session' } });
    const row = todoKv.items.get('todo.e2ee-task')!;
    expect(row.value).not.toContain(source.title);
    expect(await sync.encryption!.decryptRaw(row.value)).toMatchObject({ done: false });
    expect(getSessionsForTask(todo.id)).toEqual([expect.objectContaining({ ...scope, sessionId: 'private-session' })]);
    const writes = todoKv.writes.length;
    todoKv.items.set(row.key, { ...row, value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: todo }) });
    await expect(linkTaskToSession({ source, session: { scope, sessionId: 'another' } })).rejects.toMatchObject({ code: 'task_link_failed', cause: { code: 'todo_stored_content_unavailable', reason: 'account_mode_mismatch' } });
    expect(todoKv.writes).toHaveLength(writes);
  });

  it('retries the same creation identity from the daemon-unavailable Retry action', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const params = createRetryParams(storageState.settings);
    const hook = await renderHook(() => useCreateNewSession(params));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    const retry = alertRetry(modalAlertSpy);
    // The daemon rejects a reused Action request id whose input differs, so a
    // later retry of the same attempt must replay byte-identical input.
    vi.setSystemTime(new Date('2026-02-05T00:05:00.000Z'));
    await act(async () => { retry(); });
    await vi.waitFor(() => expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2));
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0])
      .toEqual(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]);
    await hook.unmount();
  });

  it('creates a no-folder session: managed directory, no checkout, no recent folder written', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => {
      // Accepted creation exposes the destination before the real route handoff.
      storage.getState().applySessions([
        createSessionFixture({ id: 'session-managed', serverId: 'server-a' }),
      ]);
      return spawnSuccess('session-managed');
    });
    const recentBefore = storageState.authoringMemory.recentMachinePaths;
    const params = createRetryParams(storageState.settings, {
      // The remembered folder and its checkout draft stay in the draft; neither reaches the spawn.
      selectedPath: '/tmp/remembered',
      directoryKind: 'managed',
      checkoutCreationDraft: { kind: 'git_worktree', displayName: 'feature-x', baseRef: null },
      promptStore: createNewSessionPromptStore('Write a haiku'),
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });

    expect(modalAlertSpy.mock.calls.map((call) => call[1])).not.toContain('newSession.noPathSelected');
    const request = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0];
    expect(request?.directory).toEqual({ kind: 'managed' });
    expect(request?.checkoutCreationDraft ?? null).toBeNull();
    expect(storage.getState().authoringMemory.recentMachinePaths).toEqual(recentBefore);
    await hook.unmount();
  });

  it('replays the exact persisted attempt input after a reload', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const draftId = 'reload-retry-draft';
    writeNewSessionDraft({ scope: draftScope, draftId, patch: { text: 'Reload retry' }, materializationIntent: 'userEdit' });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' });
    const paramsFor = (launchUserAttemptId: string | null) => createRetryParams(storageState.settings, {
      draftId,
      promptStore: createNewSessionPromptStore('Reload retry'),
      launchUserAttemptId,
    });

    const firstHook = await renderHook(() => useCreateNewSession(paramsFor(null)));
    await act(async () => { await firstHook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    await firstHook.unmount();

    vi.setSystemTime(new Date('2026-02-05T00:10:00.000Z'));
    const persistedAttemptId = getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })
      ?.localSupplement.launchUserAttemptId ?? null;
    expect(persistedAttemptId).toBeTruthy();
    const reloadedHook = await renderHook(() => useCreateNewSession(paramsFor(persistedAttemptId)));
    await act(async () => { await reloadedHook.getCurrent().handleCreateSession(); });
    await flushHookEffects({ cycles: 8, turns: 4 });
    await reloadedHook.unmount();

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0])
      .toEqual(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]);
  });

  it('preserves the draft and gives host setup recovery for a non-retryable terminal-host failure', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const draftId = 'terminal-host-draft';
    writeNewSessionDraft({ scope: draftScope, draftId, patch: { text: 'Keep this draft' }, materializationIntent: 'userEdit' });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ type: 'error', code: 'incompatible_target', retryable: false,
      terminalHostError: { kind: 'terminal_host_unavailable', host: 'herdr', reason: 'installation_unavailable' } });
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      draftId, promptStore: createNewSessionPromptStore('Keep this draft'),
      spawnBackendTarget: { kind: 'agent', identity: BUNDLED_AGENT_CONTRIBUTION_IDENTITIES.codex },
    })));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'newSession.terminalHostUnavailableTitle', 'newSession.terminalHostUnavailableBody',
    ]);
    expect(readDraftComposerText(getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId }))).toBe('Keep this draft');
    await hook.unmount();
  });

  it('mints a fresh attempt after a terminal spawn failure, in place and after a reload', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const { getSessionDraftSnapshot, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftScope = { serverId: 'server-a', accountId: 'account-a' } as const;
    const draftId = 'terminal-failure-draft';
    writeNewSessionDraft({ scope: draftScope, draftId, patch: { text: 'Terminal failure' }, materializationIntent: 'userEdit' });
    sessionSpawnNewActionBoundarySpy.mockResolvedValue({ type: 'error', code: 'spawn_failed', retryable: false });
    let durableUserAttemptId: string | null = null;
    const createHook = () => useCreateNewSession(createRetryParams(storageState.settings, {
      draftId,
      promptStore: createNewSessionPromptStore('Terminal failure'),
      launchUserAttemptId: durableUserAttemptId,
      onLaunchUserAttemptIdChange: (next) => { durableUserAttemptId = next; },
    }));
    const creationKeyAt = (index: number) => sessionSpawnNewActionBoundarySpy.mock.calls[index]?.[0].creationKey;

    const hook = await renderHook(createHook);
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await hook.rerender();
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    await hook.unmount();

    durableUserAttemptId = getSessionDraftSnapshot(draftScope, { kind: 'newSession', draftId })
      ?.localSupplement.launchUserAttemptId ?? null;
    const reloadedHook = await renderHook(createHook);
    await act(async () => { await reloadedHook.getCurrent().handleCreateSession(); });
    await reloadedHook.unmount();

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(3);
    expect(new Set([creationKeyAt(0), creationKeyAt(1), creationKeyAt(2)]).size).toBe(3);
  });

  it('invalidates daemon-unavailable Retry after Home, Account, Machine, path, or launch intent changes', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, modalAlertSpy, storageState } = await setupHarness();
    const changes = [
      ['Home', { targetServerId: 'server-b', draftScope: { serverId: 'server-b', accountId: 'account-a' } }],
      ['Account', { draftScope: { serverId: 'server-a', accountId: 'account-b' } }],
      ['Machine', { selectedMachineId: 'm2', selectedMachine: createMachineFixture({ id: 'm2' }) }],
      ['path', { selectedPath: '/other' }],
      ['launch intent', { launchIntentSignature: 'changed-intent' }],
    ] satisfies ReadonlyArray<readonly [string, Partial<CreateSessionParams>]>;
    for (const [name, overrides] of changes) {
      sessionSpawnNewActionBoundarySpy.mockClear();
      modalAlertSpy.mockClear();
      const initial = createRetryParams(storageState.settings);
      const hook = await renderHook((params: CreateSessionParams) => useCreateNewSession(params), { initialProps: initial });
      await act(async () => { await hook.getCurrent().handleCreateSession(); });
      const retry = alertRetry(modalAlertSpy);
      await hook.rerender({ ...initial, ...overrides });
      await act(async () => { retry(); });
      await flushHookEffects({ cycles: 8, turns: 4 });
      expect(sessionSpawnNewActionBoundarySpy, name).toHaveBeenCalledTimes(1);
      await hook.unmount();
    }
  });

  it('offers manual Retry for a typed daemon-unavailable Action without automatically retrying', async () => {
    const { useCreateNewSession, modalAlertSpy } = await setupHarness();

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await createPromise;

    expect(modalAlertSpy).toHaveBeenCalled();
    const args = modalAlertSpy.mock.calls[0] ?? [];
    expect(args).toEqual([
      'newSession.daemonRpcUnavailableTitle',
      expect.stringContaining('newSession.daemonRpcUnavailableBody'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) }),
        expect.objectContaining({ text: 'common.cancel' }),
      ]),
    ]);
    await hook.unmount();
  });

  it('does not keep the single-flight guard latched after a local validation failure', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(
      ({ selectedMachineId }: { selectedMachineId: string | null }) =>
        useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router: { push: vi.fn(), replace: vi.fn() },
          selectedMachineId,
          selectedPath: '/tmp',
          selectedMachine: selectedMachineId
            ? { id: selectedMachineId, active: true, activeAt: Date.now(), metadata: { host: 'devbox' } }
            : null,
          setIsCreating,
          setIsResumeSupportChecking: vi.fn(),
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { selectedMachineId: null as string | null } },
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    expect(sessionSpawnNewActionBoundarySpy).not.toHaveBeenCalled();

    await hook.rerender({ selectedMachineId: 'm1' });
    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });

  it('uses the latest selectedPath immediately after a rerender (no stale ref window)', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    let createPromise: Promise<void> | void | null = null;

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(
      ({ selectedPath, triggerCreate }: { selectedPath: string; triggerCreate: boolean }) => {
        const createHook = useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router: { push: vi.fn(), replace: vi.fn() },
          selectedMachineId: 'm1',
          selectedPath,
          selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating,
          setIsResumeSupportChecking: vi.fn(),
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        });

        // Simulate the user clicking "Start New Session" immediately after the path
        // rerender commits, before passive effects flush.
        React.useLayoutEffect(() => {
          if (!triggerCreate) return;
          createPromise = createHook.handleCreateSession();
        }, [triggerCreate, createHook.handleCreateSession]);

        return createHook;
      },
      { initialProps: { selectedPath: '', triggerCreate: false } },
    );

    await hook.rerender({ selectedPath: '/tmp', triggerCreate: true });

    if (!createPromise) throw new Error('expected createPromise to be assigned');
    await flushHookEffects({ runOnlyPendingTimers: true });
    await createPromise;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    const arg = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0];
    expect(arg?.directory).toEqual({ kind: 'path', path: '/tmp' });

    await hook.unmount();
  });

  it('uses the latest requested path getter even before the committed selectedPath rerenders', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    const requestedPathRef = { current: '/home/happier/projects/subdir' };
    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/home/happier',
        getRequestedPath: () => requestedPathRef.current,
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await createPromise!;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    const arg = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0];
    expect(arg?.directory).toEqual({ kind: 'path', path: '/home/happier/projects/subdir' });

    await hook.unmount();
  });

  it('does not automatically retry a typed Action rejection while offering explicit recovery', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();

    expect(modalAlertSpy).toHaveBeenCalledWith(
      'newSession.daemonRpcUnavailableTitle',
      expect.stringContaining('newSession.daemonRpcUnavailableBody'),
      expect.arrayContaining([
        expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) }),
        expect.objectContaining({ text: 'common.cancel' }),
      ]),
    );

    await hook.unmount();
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry in the hook before showing the daemon-unavailable alert', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy } = await setupHarness();

    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({
      type: 'error',
      code: 'machine_offline',
      retryable: true,
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();
  });

  it('admits and projects the accepted first prompt before opening the created session route', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, modalAlertSpy, scope } = await setupTaskHarness();
    const { storage } = await import('@/sync/domains/state/storageStore');
    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: scope.serverId, encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({ ...spawnSuccess('session-created'), executionTarget: { serverId: scope.serverId, machineId: 'm1' } });
    const router = {
      push: vi.fn(),
      replace: vi.fn(() => {
        expect(storage.getState().sessionPending['session-created']?.messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ localId: 'input-session-created', text: 'Start here', deliveryStatus: 'accepted' }),
        ]));
      }),
    };
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      router, promptStore: createNewSessionPromptStore('Start here'),
      draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId], targetAccountScope: scope,
    })));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]).toMatchObject({
      creationKey: expect.stringMatching(/^manual:/), initialInput: { text: 'Start here' },
    });
    expect(router.replace).toHaveBeenCalledTimes(1);
    const { sync } = await import('@/sync/sync');
    expect(sync.sendMessage).not.toHaveBeenCalled();
    expect(modalAlertSpy).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('publishes the first prompt as a launch attempt while spawn is unresolved', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();
    const spawnDeferred = createDeferred<SessionSpawnNewResultV1>();
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => spawnDeferred.promise);
    const onLaunchAttemptChange = vi.fn();

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Start here'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: 'server-a',
        allowedTargetServerIds: ['server-a'],
        onLaunchAttemptChange,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    try {
      await act(async () => {
        createPromise = hook.getCurrent().handleCreateSession();
        await flushHookEffects({ turns: 2 });
      });

      await vi.waitFor(() => expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1));
      const publishedAttempts = onLaunchAttemptChange.mock.calls
        .map((call) => call[0])
        .filter(Boolean);
      expect(publishedAttempts[publishedAttempts.length - 1]).toEqual(expect.objectContaining({
        status: 'spawning',
        createdSessionId: null,
        prompt: expect.objectContaining({
          prompt: 'Start here',
          displayText: 'Start here',
        }),
      }));
      expect(storageState.upsertPendingMessage).not.toHaveBeenCalled();
    } finally {
      harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
      spawnDeferred.resolve(spawnSuccess('session-created'));
      await act(async () => {
        await createPromise;
      });
      await hook.unmount();
    }
  });

  it.each(['succeeded', 'retired'] as const)('retains requester acceptance without custodian-only operation pushes through %s and ignores a mis-wired neighbor', async terminalState => {
    const context = await setupTaskHarness();
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const { readManualSessionSpawnOperation } = await import('@/sync/domains/session/spawn/manualSessionSpawnOperation');
    const { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV2RequestSchema } = await import('@happier-dev/protocol/actions/operations/v1');
    const userAttemptId = 'requester-start-without-push';
    const result = { ...spawnSuccess('requester-start-session'), executionTarget: { serverId: context.scope.serverId, machineId: 'm1' } };
    const operation = {
      version: 1 as const, operationId: 'requester-start-operation', revision: 1,
      actionId: 'session.spawn_new' as const, state: 'running' as const,
      scope: { accountId: context.scope.accountId, machineId: 'm1' },
      requestId: userAttemptId, title: 'Create session', createdAt: 1, startedAt: 2,
      cancellation: 'supported' as const,
    };
    const terminal = createDeferred<unknown>();
    let waitingForTerminal = false;
    context.additionalBoundary.rpc = async (method, input) => {
      if (method === ACTION_OPERATION_RPC_METHODS_V2.list) return {
        items: [{ ...operation, operationId: 'neighbor', requestId: 'another-click' }, operation], nextCursor: null,
      };
      if (method !== ACTION_OPERATION_RPC_METHODS_V2.get) return undefined;
      expect(ActionOperationGetV2RequestSchema.parse(input)).toMatchObject({ operationId: operation.operationId, waitForTerminal: true });
      waitingForTerminal = true;
      return await terminal.promise;
    };
    context.sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({ type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' });
    const router = { push: vi.fn(), replace: vi.fn() };
    const settlement = vi.fn();
    const hook = await renderHook(() => context.useCreateNewSession(createRetryParams(context.storageState.settings, {
      draftScope: context.scope, targetAccountScope: context.scope, targetServerId: context.scope.serverId,
      allowedTargetServerIds: [context.scope.serverId], draftId: 'requester-start-draft', launchUserAttemptId: userAttemptId,
      promptStore: createNewSessionPromptStore('One requester prompt'), router,
    })));
    let createPromise: ReturnType<ReturnType<typeof hook.getCurrent>['handleCreateSession']> | undefined;
    try {
      await act(async () => {
        createPromise = hook.getCurrent().handleCreateSession({ onAfterCreatedSettled: settlement });
        await flushHookEffects({ cycles: 8, turns: 4 });
      });
      await vi.waitFor(() => expect(waitingForTerminal).toBe(true));
      expect(settlement).not.toHaveBeenCalled();
      if (terminalState === 'retired') {
        await hook.unmount();
        terminal.resolve({ kind: 'found', operation: { ...operation, state: 'succeeded', revision: 2, settledAt: 3, result } });
        await createPromise;
        expect(settlement).not.toHaveBeenCalled();
        expect(router.replace).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        expect(context.modalAlertSpy).not.toHaveBeenCalled();
        expect(context.sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
        expect(readManualSessionSpawnOperation(context.scope, userAttemptId)?.operationId).toBe(operation.operationId);
        expect(Array.from(actionOperationStore.getSnapshot().operationsByKey.values())
          .some(candidate => candidate.snapshot.operationId === 'neighbor')).toBe(false);
        return;
      }
      await act(async () => {
        context.storageState.applySessions([createSessionFixture({ id: result.sessionId, serverId: context.scope.serverId, encryptionMode: 'plain' })]);
        terminal.resolve({ kind: 'found', operation: { ...operation, state: 'succeeded', revision: 2, settledAt: 3, result } });
      });
      await vi.waitFor(() => expect(settlement).toHaveBeenCalledWith({ status: 'accepted', sessionId: result.sessionId }));
      await createPromise;
      expect(router.replace).toHaveBeenCalledWith(expect.stringContaining('/session/requester-start-session'), expect.anything());
      expect(context.modalAlertSpy).not.toHaveBeenCalled();
      expect(context.sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    } finally {
      terminal.resolve({ kind: 'not_found' });
      await createPromise;
      await hook.unmount();
    }
  });

  it.each(['succeeded', 'failed', 'cancelled', 'retired'] as const)('joins a daemon-qualified manual start through canonical %s settlement without warning or replay', async terminalState => {
    const context = await setupTaskHarness();
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const { writeNewSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    const draftId = 'accepted-start-draft';
    const userAttemptId = 'accepted-start-attempt';
    const daemonServerId = 'stack_agent-qa-machine-resources__id_default';
    const prompt = 'Keep the accepted first input';
    writeNewSessionDraft({ scope: context.scope, draftId, patch: { text: prompt }, materializationIntent: 'userEdit' });
    const operation = {
      version: 1 as const, operationId: 'accepted-start-operation', revision: 1,
      actionId: 'session.spawn_new' as const, state: 'running' as const,
      scope: { accountId: context.scope.accountId, machineId: 'm1' },
      requestId: `manual:${userAttemptId}`, title: 'Create session', createdAt: 1, startedAt: 2,
      cancellation: 'supported' as const,
    };
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const terminal = createDeferred<unknown>();
    let operationDetailReads = 0;
    context.additionalBoundary.rpc = async (method, input) => {
      if (method !== ACTION_OPERATION_RPC_METHODS_V2.get) return undefined;
      operationDetailReads += 1;
      expect(input).toMatchObject({ operationId: operation.operationId, waitForTerminal: true });
      return await terminal.promise;
    };
    context.sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async () => {
      actionOperationStore.mergeSnapshots({ serverId: context.scope.serverId, snapshots: [operation] });
      return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted',
        operation: { serverId: daemonServerId, machineId: 'm1', operationId: operation.operationId } };
    });
    const router = { push: vi.fn(), replace: vi.fn() };
    const settlement = vi.fn();
    const attempts = vi.fn();
    const promptStore = createNewSessionPromptStore(prompt);
    const hook = await renderHook(() => {
      const [isCreating, setIsCreating] = React.useState(false);
      const launch = context.useCreateNewSession(createRetryParams(context.storageState.settings, {
        draftScope: context.scope, targetAccountScope: context.scope, targetServerId: context.scope.serverId,
        allowedTargetServerIds: [context.scope.serverId], draftId, launchUserAttemptId: userAttemptId,
        promptStore, router, onLaunchAttemptChange: attempts, setIsCreating,
      }));
      return { ...launch, isCreating };
    });
    await act(async () => {
      hook.getCurrent().handleCreateSession({ onAfterCreatedSettled: settlement });
      await flushHookEffects({ cycles: 8, turns: 4 });
    });
    await vi.waitFor(() => expect(context.sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(operationDetailReads).toBe(1));
    expect(context.modalAlertSpy).not.toHaveBeenCalled();
    expect(settlement).not.toHaveBeenCalled();
    expect(hook.getCurrent().isCreating).toBe(true);
    expect(router.replace).not.toHaveBeenCalled();
    expect(attempts.mock.calls.at(-1)?.[0]).toMatchObject({ status: 'spawning' });
    expect(readDraftComposerText(getSessionDraftSnapshot(context.scope, { kind: 'newSession', draftId }))).toBe(prompt);
    if (terminalState === 'retired') {
      await hook.unmount();
      terminal.resolve({ kind: 'not_found' });
      expect(router.replace).not.toHaveBeenCalled();
      expect(context.modalAlertSpy).not.toHaveBeenCalled();
      expect(readDraftComposerText(getSessionDraftSnapshot(context.scope, { kind: 'newSession', draftId }))).toBe(prompt);
      return;
    }
    const result = { ...spawnSuccess('accepted-start-session'), executionTarget: { serverId: daemonServerId, machineId: 'm1' } };
    const observedDetailHttp: string[] = [];
    context.additionalBoundary.http = async (url, init) => {
      observedDetailHttp.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      return null;
    };
    await act(async () => {
      context.storageState.applySessions([createSessionFixture({ id: result.sessionId, serverId: context.scope.serverId, encryptionMode: 'plain' })]);
      actionOperationStore.mergeSnapshots({ serverId: context.scope.serverId, snapshots: [{ ...operation,
        state: terminalState, revision: 2, settledAt: 3,
        // The real daemon list deliberately omits settled result bodies. The
        // qualified get owner retains the actual first-input disposition.
        ...(terminalState === 'failed' ? { error: { errorCode: 'spawn_failed', error: 'Runner failed' } } : {}),
      }] });
      terminal.resolve({ kind: 'found', operation: { ...operation, state: terminalState, revision: 2, settledAt: 3,
        ...(terminalState === 'succeeded' ? { result } : {}),
        ...(terminalState === 'failed' ? { error: { errorCode: 'spawn_failed', error: 'Runner failed' } } : {}),
      } });
      await flushHookEffects({ cycles: 8, turns: 4 });
    });
    await vi.waitFor(async () => {
      await flushHookEffects({ cycles: 8, turns: 4 });
      expect(settlement.mock.calls.length, JSON.stringify({ alerts: context.modalAlertSpy.mock.calls,
        rpcMethods: context.machineRpcSpy.mock.calls.map(call => call[1]), detailHttp: observedDetailHttp,
        operationDetailReads, latestAttempt: attempts.mock.calls.at(-1)?.[0]?.status,
        routed: router.replace.mock.calls.length,
        endpointStatus: context.storageState.endpointStatus, endpointReason: context.storageState.endpointReason })).toBe(1);
      if (terminalState === 'succeeded') expect(router.replace).toHaveBeenCalledTimes(1);
    });
    expect(context.sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    if (terminalState === 'succeeded') {
      expect(router.replace).toHaveBeenCalledWith(expect.stringContaining('/session/accepted-start-session'), expect.anything());
      expect(settlement).toHaveBeenCalledWith({ status: 'accepted', sessionId: result.sessionId });
      expect(context.storageState.sessionPending[result.sessionId]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ localId: 'input-accepted-start-session', text: prompt, deliveryStatus: 'accepted' }),
      ]));
      const { sync } = await import('@/sync/sync');
      expect(sync.sendMessage).not.toHaveBeenCalled();
      expect(context.modalAlertSpy).not.toHaveBeenCalled();
    } else {
      expect(router.replace).not.toHaveBeenCalled();
      expect(readDraftComposerText(getSessionDraftSnapshot(context.scope, { kind: 'newSession', draftId }))).toBe(prompt);
    }
    await hook.unmount();
  });

  it('keeps a pending Action unresolved without duplicating creation', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      sessionSpawnNewActionBoundarySpy,
      storageState,
    } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({
      type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
    });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Start here'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    const creationKey = (sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as any)?.creationKey;
    expect(creationKey).toEqual(expect.stringMatching(/^manual:new-session-attempt-/));
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
    expect(router.replace).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'common.error',
      expect.stringContaining('newSession.launchStillPendingBody'),
    );

    await hook.unmount();
  });

  it.each([
    {
      initialInput: { status: 'outcomeUnknown' as const, localId: 'input-session-created', code: 'transport_unavailable' },
      // The Session exists and the draft is kept: the title says what to do, never a bare "Error".
      expectedTitle: 'newSession.initialInputNotConfirmedTitle',
      expectedLabel: 'newSession.initialInputNotConfirmed',
    },
    {
      initialInput: { status: 'rejected' as const, code: 'session_input_idempotency_conflict' as const },
      expectedTitle: 'newSession.initialInputRejectedTitle',
      expectedLabel: 'session.pendingMessages.admissionRejected.idempotencyConflict',
    },
    {
      initialInput: { status: 'rejected', code: 'session_input_storage_unavailable' } as const,
      expectedTitle: 'newSession.initialInputRejectedTitle',
      expectedLabel: 'session.pendingMessages.admissionRejected.storageUnavailable',
    },
  ])('preserves and explains a $initialInput.status ($initialInput.code) first prompt without sending it twice', async ({ initialInput, expectedTitle, expectedLabel }) => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState, modalAlertSpy, scope } = await setupTaskHarness();
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
    const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: scope.serverId, encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({
      ...spawnSuccess('session-created'),
      type: 'success', disposition: 'created', sessionId: 'session-created',
      executionTarget: { serverId: scope.serverId, machineId: 'm1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput,
    });
    let firstPromptAtNavigation: string | undefined;
    let warnedBeforeNavigation = false;
    const router = { push: vi.fn(), replace: vi.fn(() => {
      firstPromptAtNavigation = readDraftComposerText(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'session-created' }));
      warnedBeforeNavigation = modalAlertSpy.mock.calls.some((call) => typeof call[1] === 'string'
        && call[1].includes(expectedLabel) && call[1].includes(initialInput.code));
    }) };
    const hook = await renderHook(() => useCreateNewSession(createRetryParams(storageState.settings, {
      promptStore: createNewSessionPromptStore('Keep this first prompt'), router,
      draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      targetAccountScope: scope,
    })));
    await act(async () => { await hook.getCurrent().handleCreateSession(); });
    expect(sessionSpawnNewActionBoundarySpy.mock.calls, JSON.stringify({ alerts: modalAlertSpy.mock.calls, rpc: harness.machineRpcSpy.mock.calls })).toHaveLength(1);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0].initialInput).toEqual({ text: 'Keep this first prompt' });
    expect(readDraftComposerText(getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 'session-created' }))).toBe('Keep this first prompt');
    const { sync } = await import('@/sync/sync');
    expect(sync.sendMessage).not.toHaveBeenCalled();
    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalledWith(expectedTitle, expect.stringContaining(initialInput.code));
    expect(modalAlertSpy).toHaveBeenCalledWith(expectedTitle, expect.stringContaining(expectedLabel));
    expect(warnedBeforeNavigation).toBe(true);
    expect(firstPromptAtNavigation).toBe('Keep this first prompt');
    await hook.unmount();
  });

  it('retries an outcome-unknown Action with the same creation identity', async () => {
    const {
      useCreateNewSession,
      modalAlertSpy,
      sessionSpawnNewActionBoundarySpy,
      storageState,
    } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-after-retry', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy
      .mockResolvedValueOnce({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
      })
      .mockResolvedValueOnce(spawnSuccess('session-after-retry'));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Retry same nonce'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(router.replace).not.toHaveBeenCalled();
    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };
    expect(firstSpawnOptions).not.toHaveProperty('initialPrompt');
    await act(async () => { await hook.getCurrent().handleCreateSession(); });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    expect(sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      creationKey: firstSpawnOptions.creationKey,
    }));
    expect(router.replace).toHaveBeenCalledWith('/session/session-after-retry?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('retains the real custody creation identity across remount after an unknown outcome', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewActionBoundarySpy,
      storageState,
    } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({
      id: 'session-from-operation-settlement',
      serverId: 'server-a',
      encryptionMode: 'plain',
    })]);
    sessionSpawnNewActionBoundarySpy
      .mockResolvedValueOnce({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
      })
      .mockResolvedValueOnce(spawnSuccess('session-from-operation-settlement'));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    let durableUserAttemptId: string | null = null;
    const createHook = () =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore('Retry after route stall'),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
        launchUserAttemptId: durableUserAttemptId,
        onLaunchUserAttemptIdChange: (next) => {
          durableUserAttemptId = next;
        },
      });

    const firstHook = await renderHook(createHook);
    await act(async () => {
      await firstHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await firstHook.unmount();

    const secondHook = await renderHook(createHook);
    await act(async () => {
      await secondHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await secondHook.unmount();

    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };
    const secondSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0] as {
      creationKey?: string;
    };

    expect(secondSpawnOptions.creationKey).toBe(sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0].creationKey);
    expect(secondSpawnOptions.creationKey).toMatch(/^manual:.+/);
  });

  it('keeps the unresolved launch barrier after remounting with a changed prompt on the same launch scope', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewActionBoundarySpy,
    } = await setupHarness();

    sessionSpawnNewActionBoundarySpy
      .mockResolvedValue({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
      });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const createHook = (sessionPrompt: string) =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm-remount-prompt',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm-remount-prompt', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(sessionPrompt),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      });

    const firstHook = await renderHook(() => createHook('First timed-out prompt'));
    await act(async () => {
      await firstHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await firstHook.unmount();

    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };

    const secondHook = await renderHook(() => createHook('Changed prompt after timeout'));
    await act(async () => {
      await secondHook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });
    await secondHook.unmount();

    const secondSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0] as {
      creationKey?: string;
    };

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    expect(secondSpawnOptions.creationKey).not.toBe(firstSpawnOptions.creationKey);
  });

  it('rotates the action identity when the canonical launch intent changes on the same mounted screen', async () => {
    const {
      useCreateNewSession,
      sessionSpawnNewActionBoundarySpy,
    } = await setupHarness();

    sessionSpawnNewActionBoundarySpy
      .mockResolvedValue({
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'unknown',
      });

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(
      ({ launchIntentSignature }: { launchIntentSignature: string }) =>
        useCreateNewSession({
          router: { push: vi.fn(), replace: vi.fn() },
          selectedMachineId: 'm-mounted-prompt',
          selectedPath: '/tmp',
          selectedMachine: { id: 'm-mounted-prompt', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating: vi.fn(),
          setIsResumeSupportChecking: vi.fn(),
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore('Unchanged prompt'),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
          launchUserAttemptId: 'persisted-attempt-a',
          launchIntentSignature,
        }),
      { initialProps: { launchIntentSignature: 'intent-a' } },
    );

    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    const firstSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[0]?.[0] as {
      creationKey?: string;
    };

    await hook.rerender({ launchIntentSignature: 'intent-b' });
    await act(async () => {
      await hook.getCurrent().handleCreateSession();
    });
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(2);
    const secondSpawnOptions = sessionSpawnNewActionBoundarySpy.mock.calls[1]?.[0] as {
      creationKey?: string;
    };
    expect(secondSpawnOptions.creationKey).not.toBe(firstSpawnOptions.creationKey);

    await hook.unmount();
  });

  it('offers Retry for daemon-unavailable post-create follow-up failures without creating another session', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    const retryableFollowUpError = Object.assign(new Error('Machine target not available for session'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(retryableFollowUpError)
      .mockResolvedValueOnce(undefined);

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
    });
    await vi.waitFor(() => expect(modalAlertSpy.mock.calls.some((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    })).toBe(true));
    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    expect(retryAlertCall).toBeTruthy();
    expect(modalAlertSpy.mock.calls.some((call) => call[0] === 'common.error')).toBe(false);
    const buttons = (retryAlertCall?.[2] ?? []) as any[];
    const retry = buttons.find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      retry.onPress();
    });
    await createPromise;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      effectiveSpawnServerId: 'server-a',
      launchAttempt: expect.objectContaining({
        attachmentMessageLocalId: expect.stringMatching(/^plugin-input-v1:/),
      }),
    }));
    expect(router.replace).toHaveBeenCalledTimes(1);

    await hook.unmount();
  });

  it('drops duplicate create requests while a launch is already in flight', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValue(spawnSuccess('session-created'));
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let firstCreate: Promise<void> | void | null = null;
    let secondCreate: Promise<void> | void | null = null;
    await act(async () => {
      firstCreate = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
      secondCreate = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    await vi.waitFor(() => expect(afterCreated).toHaveBeenCalledTimes(1));
    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(1);

    resolveAfterCreated();
    await firstCreate;
    await secondCreate;

    await hook.unmount();
  });

  it('does not navigate when launch scope changes before completion', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };
    const setIsCreating = vi.fn();

    const hook = await renderHook(
      ({ targetServerId }: { targetServerId: string | null }) =>
        useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router,
          selectedMachineId: 'm1',
          selectedPath: '/tmp',
          selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating,
          setIsResumeSupportChecking: vi.fn(),
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId,
          allowedTargetServerIds: ['server-a', 'server-b'],
        }),
      { initialProps: { targetServerId: 'server-a' as string | null } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await vi.waitFor(() => expect(afterCreated).toHaveBeenCalledTimes(1));
    await hook.rerender({ targetServerId: 'server-b' });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ cycles: 8, turns: 4 });

    expect(router.replace).not.toHaveBeenCalled();
    expect(setIsCreating).toHaveBeenLastCalledWith(false);

    await hook.unmount();
  });

  it('keeps routing when macOS resolves a /tmp launch path to its /private/tmp canonical path', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(
      ({ selectedPath }: { selectedPath: string }) =>
        useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router,
          selectedMachineId: 'm1',
          selectedPath,
          selectedMachine: {
            id: 'm1',
            active: true,
            activeAt: Date.now(),
            metadata: { host: 'devbox', platform: 'darwin', homeDir: '/Users/leeroy' },
          },
          setIsCreating: vi.fn(),
          setIsResumeSupportChecking: vi.fn(),
          useProfiles: false,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { selectedPath: '/tmp/happier-ruqa-late-opencode-hqzCRl' } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await vi.waitFor(() => expect(afterCreated).toHaveBeenCalledTimes(1));
    await hook.rerender({ selectedPath: '/private/tmp/happier-ruqa-late-opencode-hqzCRl' });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('keeps launch pending and routes when the created session hydrates after an initial route-readiness miss', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState, scope, additionalBoundary } = await setupTaskHarness();
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce({ ...spawnSuccess('session-created'),
      executionTarget: { serverId: scope.serverId, machineId: 'm1' } });
    let sessionPublished = false;
    let observedMissingSession = false;
    additionalBoundary.http = async url => {
      if (url.pathname !== '/v2/sessions/session-created') return null;
      if (!sessionPublished) {
        observedMissingSession = true;
        return Response.json({ error: 'Session not found' }, { status: 404 });
      }
      return Response.json({ session: createPlainSessionCurrentProjectionRecordFixture({ id: 'session-created',
        metadata: { path: '/tmp', host: 'devbox', machineId: 'm1' } }) });
    };
    const router = { push: vi.fn(), replace: vi.fn() };
    const setIsCreating = vi.fn();
    const params = createRetryParams(storageState.settings, {
      router, setIsCreating, draftScope: scope, targetServerId: scope.serverId, allowedTargetServerIds: [scope.serverId],
      promptStore: createNewSessionPromptStore(''),
    });
    const hook = await renderHook(() => useCreateNewSession(params));
    await act(async () => {
      hook.getCurrent().handleCreateSession({ initialMessage: 'skip' });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await vi.waitFor(() => expect(observedMissingSession).toBe(true));
    expect(router.replace).not.toHaveBeenCalled();
    sessionPublished = true;
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/session/session-created?serverId=${scope.serverId}`, expect.anything()));
    expect(modalAlertSpy).not.toHaveBeenCalled();
    expect(setIsCreating).toHaveBeenCalledWith(true);
    expect(setIsCreating).not.toHaveBeenCalledWith(false);

    await hook.unmount();
  });

  it('treats profile-mode changes as launch scope changes', async () => {
    const { useCreateNewSession, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    let resolveAfterCreated: () => void = () => {
      throw new Error('expected afterCreated to be waiting');
    };
    const afterCreated = vi.fn(async () => new Promise<void>((resolve) => {
      resolveAfterCreated = resolve;
    }));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(
      ({ useProfiles }: { useProfiles: boolean }) =>
        useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
          router,
          selectedMachineId: 'm1',
          selectedPath: '/tmp',
          selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
          setIsCreating: vi.fn(),
          setIsResumeSupportChecking: vi.fn(),
          useProfiles,
          selectedProfileId: null,
          profileMap: new Map(),
          recentMachinePaths: [],
          agentType: 'codex' as any,
          permissionMode: 'default' as PermissionMode,
          modelMode: 'default' as ModelMode,
          promptStore: createNewSessionPromptStore(''),
          resumeSessionId: '',
          agentNewSessionOptions: null,
          machineEnvPresence,
          secrets: [],
          secretBindingsByProfileId: {},
          selectedSecretIdByProfileIdByEnvVarName: {},
          resolveSavedSecretReference,
          sessionOnlySecretValueByProfileIdByEnvVarName: {},
          selectedMachineCapabilities: {},
          targetServerId: undefined,
          allowedTargetServerIds: undefined,
        }),
      { initialProps: { useProfiles: false } },
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ initialMessage: 'skip', afterCreated });
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await vi.waitFor(() => expect(afterCreated).toHaveBeenCalledTimes(1));
    await hook.rerender({ useProfiles: true });

    resolveAfterCreated();
    await createPromise;
    await flushHookEffects({ runOnlyPendingTimers: true });

    expect(router.replace).not.toHaveBeenCalled();

    await hook.unmount();
  });

  it('retries post-create follow-up failures against the created session without respawning', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    const retryPresented = createDeferred<void>();
    modalAlertSpy.mockImplementationOnce(() => retryPresented.resolve(undefined));
    const spawnDispatch = createDeferred<SessionSpawnNewInputV2>();
    sessionSpawnNewActionBoundarySpy.mockImplementationOnce(async (input) => {
      spawnDispatch.resolve(input);
      return spawnSuccess('session-created');
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(new Error('Created session is not available locally yet'))
      .mockResolvedValueOnce(undefined);

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };
    const router = { push: vi.fn(), replace: vi.fn() };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router,
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
      await spawnDispatch.promise;
      await retryPresented.promise;
      await flushHookEffects({ runOnlyPendingTimers: true });
    });

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    expect(retryAlertCall).toBeTruthy();
    const retry = ((retryAlertCall?.[2] ?? []) as Array<{ text?: string; onPress?: () => void }>)
      .find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      retry?.onPress?.();
      await flushHookEffects({ runOnlyPendingTimers: true });
    });
    await createPromise;

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    expect(afterCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: 'session-created',
      launchAttempt: expect.objectContaining({
        createdSessionId: 'session-created',
      }),
    }));
    expect(router.replace).toHaveBeenCalledWith('/session/session-created?serverId=server-a', expect.anything());

    await hook.unmount();
  });

  it('shows the generic follow-up error when retry fails for a non-daemon reason', async () => {
    const { useCreateNewSession, modalAlertSpy, sessionSpawnNewActionBoundarySpy, storageState } = await setupHarness();

    harness.storageState.applySessions([createSessionFixture({ id: 'session-created', serverId: 'server-a', encryptionMode: 'plain' })]);
    sessionSpawnNewActionBoundarySpy.mockResolvedValueOnce(spawnSuccess('session-created'));
    const retryableFollowUpError = Object.assign(new Error('Machine target not available for session'), {
      rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    });
    const afterCreated = vi.fn()
      .mockRejectedValueOnce(retryableFollowUpError)
      .mockRejectedValueOnce(new Error('Attachment validation failed'));

    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    const hook = await renderHook(() =>
      useCreateNewSession({
        launchIntentSignature: 'test-launch-intent',
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        promptStore: createNewSessionPromptStore(''),
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        resolveSavedSecretReference,
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: undefined,
        allowedTargetServerIds: undefined,
      }),
    );

    let createPromise: Promise<void> | void | null = null;
    await act(async () => {
      createPromise = hook.getCurrent().handleCreateSession({ afterCreated });
    });
    await vi.waitFor(() => expect(modalAlertSpy.mock.calls.some((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    })).toBe(true));

    const retryAlertCall = modalAlertSpy.mock.calls.find((call) => {
      const buttons = call[2];
      return Array.isArray(buttons) && buttons.some((button) => button?.text === 'common.retry');
    });
    const buttons = (retryAlertCall?.[2] ?? []) as any[];
    const retry = buttons.find((button) => button?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      retry.onPress();
    });
    await createPromise;
    await vi.waitFor(() => expect(afterCreated).toHaveBeenCalledTimes(2));

    expect(sessionSpawnNewActionBoundarySpy).toHaveBeenCalledTimes(1);
    expect(afterCreated).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(modalAlertSpy.mock.calls).toContainEqual([
      'common.error',
      'Attachment validation failed',
    ]));

    await hook.unmount();
  });


});
