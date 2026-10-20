import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ExecutionRunStartResponseSchema, SessionCurrentProjectionRecordV1Schema, SessionMetadataTuplePatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema, SessionMetadataVersionConflictV1Schema, MACHINE_PLAIN_DATA_KEY_MARKER,
  SessionSpawnNewInputV2Schema, SessionOwnerMetadataEnvelopeV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonSessionGoalGetRequestV1Schema, DaemonSessionGoalSetRequestV2Schema,
  DaemonSessionGoalClearRequestV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createSessionFixture, createExistingSessionDirectoryPreflightResult, createPlainSessionCurrentProjectionRecordFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ComposerAttachmentDraftV1Schema } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { bindMachineAccessActionHttpRequestV1, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions';
import { actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { SessionStopResultSchema, isSessionStopConfirmed } from '@happier-dev/protocol/sessions/control/contract';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';

// A real product platform is required for executing-client evidence. The
// generic Node RN stub intentionally has no client category.
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
// These transport assertions exercise the request after the present user
// accepts the real shared confirmation policy at its presentation boundary.
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ confirmResult: true }).module;
});
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

const outgoing: SocketRpcRequestPayload[] = [];
// Native file APIs are an OS boundary, outside this HTTP/Action journey.
vi.mock('expo-file-system', async () => (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
let daemonAnswer: (request: SocketRpcRequestPayload) => unknown = () => { throw new Error('Unexpected daemon request'); };
const configureSessionSocket: NonNullable<Parameters<typeof restoreServerAccountForTest>[0]['configureSocket']> = (socket) => {
  vi.mocked(socket.connect).mockImplementation(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) {
      throw new Error('Malformed socket RPC request');
    }
    const request: SocketRpcRequestPayload = { method: payload.method, params: payload.params };
    outgoing.push(request);
    return { ok: true, result: await daemonAnswer(request) };
  });
};
installDisconnectedServerSocketBoundary(configureSessionSocket);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const originalState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;

function installSession(id: string, partialMetadata: Partial<NonNullable<ReturnType<typeof createSessionFixture>['metadata']>>, ownerServerId = serverId) {
  const metadata = { path: '/repo', host: 'tester.local', ...partialMetadata };
  const session = createSessionFixture({ id, serverId: ownerServerId, active: true, metadata });
  storage.setState({ sessions: { ...storage.getState().sessions, [id]: session } });
  let row = SessionCurrentProjectionRecordV1Schema.parse({
    ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(metadata),
    effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
    responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
    agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
  });
  const answer = { select: (input: unknown) => {
    if (input === undefined || input === null) return { body: { session: row } };
    const patch = SessionMetadataTuplePatchV1Schema.parse(input);
    if (patch.mode === 'shared_editor') throw new Error('Owner mode change used shared-editor metadata');
    const target = patch.mode === 'owner_migration' ? patch.target : patch;
    row = SessionCurrentProjectionRecordV1Schema.parse({ ...row,
      metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
      ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
      metadataVersion: row.metadataVersion + 1, agentStateVersion: (row.agentStateVersion ?? 0) + 1,
    });
    return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
  } };
  homes.answer(ownerServerId, `/v2/sessions/${id}`, answer);
  homes.answer(ownerServerId, `/v2/sessions/${id}?accessProjectionVersion=1`, answer);
  return () => row;
}

/** Hold actual HTTP body bytes after headers, retaining the request's abort semantics. */
function holdSessionResponseBody(sessionId: string, suffix = '', method = 'GET') {
  const reading = createDeferred<void>();
  const released = createDeferred<void>();
  let held = false;
  setRuntimeFetch(async (input, init) => {
    const response = await homes.request(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (held || (init?.method ?? 'GET') !== method || url.pathname !== `/v2/sessions/${sessionId}${suffix}`) return response;
    held = true;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        reading.resolve();
        await released.promise;
        if (init?.signal?.aborted) {
          controller.error(init.signal.reason ?? new DOMException('Aborted', 'AbortError'));
          return;
        }
        controller.enqueue(bytes);
        controller.close();
      },
    }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
  });
  return { reading: reading.promise, release: () => released.resolve(),
    restore: () => installHomeGovernanceBoundaries(homes) };
}

const modes = (agentId: string, currentModeId: string, ids: readonly string[]) => ({
  v: 1 as const, agentId, updatedAt: 1, currentModeId,
  availableModes: ids.map((id) => ({ id, name: id === 'default' ? 'Default' : id === 'build' ? 'Build' : 'Plan' })),
});
const context = () => ({ surface: 'ui' as const, authority: 'present_user' as const, serverId });

function installActionSettings(actions: unknown) {
  const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions }) };
  storage.setState({ settings });
  // The restored Account still performs its ordinary settings fetch. Serve
  // the same Account policy at that boundary, rather than letting an empty
  // fixture overwrite the UI projection between admission and feedback.
  homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
}

describe('default Action executor mode and catalog contracts', () => {
  it('sends structured ordinary input to an exact cold Session on the active Home without warming the Session store', async () => {
    installSession('cold-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ sessions: {} });
    const baseline = createRootLayoutFeaturesResponse();
    const features = createRootLayoutFeaturesResponse({ capabilities: { ...baseline.capabilities,
      session: { ...baseline.capabilities.session, pendingInput: { protocolVersion: 1 } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const structuredInput = { v: 1, mentions: [{ kind: 'happier.session', ref: 'session:source', token: '@source' }] };
    homes.answer(serverId, '/v2/sessions/cold-session/pending', { select: body => {
      const input = StrictJsonValueSchema.parse(body);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected Pending mutation object');
      if (!('requestedAction' in input) || !('localId' in input)) throw new Error('Expected Pending mutation identity');
      expect(input).toMatchObject({ localId: 'cold-input', requestedAction: { v: 1, kind: 'send_now' },
        content: { t: 'plain', v: { content: { text: '@source inspect it.' }, meta: { happierStructuredInputV1: structuredInput } } } });
      return { body: { requestedAction: input.requestedAction, pending: { localId: input.localId } } };
    } });
    const result = await createDefaultActionExecutor().execute('session.message.send', {
      sessionId: 'cold-session', message: '@source inspect it.', reply: 'none', localId: 'cold-input', structuredInput,
      requestedAction: { v: 1, kind: 'send_now' },
    }, context());
    expect(result).toEqual({ ok: true, result: { status: 'accepted', localId: 'cold-input' } });
    expect(storage.getState().sessions['cold-session']).toBeUndefined();
    expect(homes.requestsFor('/v2/sessions/cold-session/pending')).toHaveLength(1);
  });
  it('retires default ACP metadata publication while the captured Session body is held', async () => {
    const sessionId = 'retired-acp-body';
    installSession(sessionId, { path: '/private/captured-account', flavor: 'opencode' });
    storage.setState({ sessions: {} });
    const body = holdSessionResponseBody(sessionId);
    const { sync } = await import('@/sync/sync');
    const publication = sync.publishSessionAcpSessionModeOverrideToMetadata({ sessionId, modeId: 'plan', updatedAt: 2 })
      .then(() => ({ status: 'fulfilled' as const }), error => ({ status: 'rejected' as const, error }));
    try {
      await Promise.race([body.reading, publication.then(() => { throw new Error('ACP publication completed before the held Session body'); })]);
      const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      await disconnectActiveServerConnection();
      await TokenStorage.removeCredentialsForServerUrl('https://mode-actions.test', { serverId });
      body.release();
      const outcome = await publication;
      expect(storage.getState().sessions[sessionId]).toBeUndefined();
      expect(homes.requestsFor(`/v2/sessions/${sessionId}`).filter(request => request.input !== null)).toEqual([]);
      expect(outcome).toMatchObject({ status: 'rejected', error: { cause: { code: 'session_account_scope_retired' } } });
    } finally {
      body.release();
      await publication;
      body.restore();
    }
  });
  it('retires a basic Action send before outbox custody while the captured Session body is held', async () => {
    const sessionId = 'retired-send-body';
    const localId = 'retired-send-input';
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const originalScope = captureActiveServerAccountScopeLifetime()!.scope;
    installSession(sessionId, { path: '/private/captured-account', flavor: 'claude' });
    storage.setState({ sessions: {} });
    const baseline = createRootLayoutFeaturesResponse();
    const features = createRootLayoutFeaturesResponse({ capabilities: { ...baseline.capabilities,
      session: { ...baseline.capabilities.session, pendingInput: { protocolVersion: 1 } } } });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    homes.answer(serverId, `/v2/sessions/${sessionId}/pending`, { status: 503, body: { error: 'unavailable' } });
    const body = holdSessionResponseBody(sessionId);
    const send = createDefaultActionExecutor().execute('session.message.send', {
      sessionId, message: 'Do not send after logout.', reply: 'none', localId,
      requestedAction: { v: 1, kind: 'send_now' },
    }, context());
    const { loadPendingOutboxForSession, removePendingOutboxMessage } = await import('@/sync/domains/state/pendingOutboxPersistence');
    try {
      await Promise.race([body.reading, send.then(() => { throw new Error('Basic Action send completed before the held Session body'); })]);
      const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      await disconnectActiveServerConnection();
      await TokenStorage.removeCredentialsForServerUrl('https://mode-actions.test', { serverId });
      body.release();
      const outcome = await send;
      expect({ pendingRequests: homes.requestsFor(`/v2/sessions/${sessionId}/pending`).length,
        outboxRows: (await loadPendingOutboxForSession(sessionId, originalScope)).length,
      }).toEqual({ pendingRequests: 0, outboxRows: 0 });
      expect(outcome).toMatchObject({ ok: false, errorCode: 'tool_cancelled' });
    } finally {
      body.release();
      await send.catch(() => undefined);
      await removePendingOutboxMessage(sessionId, localId, originalScope);
      body.restore();
    }
  });
  it.each(['focus-switch', 'credential-replacement'] as const)(
    'keeps explicit Home metadata authority independent from ambient %s', async change => {
    const targetServerId = await homes.addHome({ name: 'Target metadata Home', serverUrl: 'https://target-metadata.test',
      accountId: 'bob', currentAccount: true });
    const nextServerId = await homes.addHome({ name: 'Next ambient Home', serverUrl: 'https://next-ambient.test',
      accountId: 'carol', currentAccount: true });
    const sessionId = 'explicit-home-metadata';
    const read = installSession(sessionId, { path: '/private/target-account', flavor: 'claude' }, targetServerId);
    storage.setState({ sessions: {} });
    const body = holdSessionResponseBody(sessionId);
    const publication = createDefaultActionExecutor().execute('session.approval_reviewer.set', {
      sessionId, enabled: true,
    }, { ...context(), serverId: targetServerId });
    try {
      await Promise.race([body.reading, publication.then(() => { throw new Error('Explicit Home publication completed before the held Session body'); })]);
      if (change === 'focus-switch') {
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        await setActiveServerId(nextServerId, { scope: 'device' });
        await switchConnectionToActiveServer();
      } else {
        await homes.switchAccount(targetServerId, 'replacement', { currentAccount: true });
        homes.answer(targetServerId, `/v2/sessions/${sessionId}`, { status: 403, body: { error: 'Forbidden' } });
        homes.answer(targetServerId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { status: 403, body: { error: 'Forbidden' } });
      }
      body.release();
      const result = await publication;
      const writes = homes.requestsFor(`/v2/sessions/${sessionId}`).filter(request => request.input !== null);
      if (change === 'focus-switch') {
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(writes.map(request => request.serverId)).toEqual([targetServerId]);
        const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
        if (owner.t !== 'plain') throw new Error('Unreadable owner metadata');
        expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v })
          .approvalReviewerEnabled).toBe(true);
      } else {
        expect(writes).toHaveLength(0);
        expect(storage.getState().sessions[sessionId]).toBeUndefined();
        expect(result).toMatchObject({ ok: false });
      }
    } finally {
      body.release();
      await publication.catch(() => undefined);
      body.restore();
    }
  });
  it('withdraws acquired metadata writer authority on a same-Home semantic invalidation before CAS', async () => {
    const sessionId = 'retired-metadata-writer';
    installSession(sessionId, { path: '/private/captured-account', flavor: 'claude' });
    storage.setState({ sessions: {} });
    const { sync } = await import('@/sync/sync');
    const { invalidateAccountEncryptionModeCacheForChanges } = await import('@/sync/api/account/apiAccountEncryptionMode');
    const publication = sync.patchSessionMetadataWithRetry(sessionId, metadata => {
      // The real tuple has already been acquired. An unknown self hint is a
      // conservative encryption withdrawal, including between read and CAS.
      expect(homes.requests.some(request => request.path.split('?')[0] === `/v2/sessions/${sessionId}`
        && request.input === null)).toBe(true);
      invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self' }]);
      return { ...metadata, approvalReviewerEnabled: true };
    }, { serverId });
    await expect(publication).rejects.toMatchObject({ code: 'account_encryption_currentness_changed' });
    expect(homes.requestsFor(`/v2/sessions/${sessionId}`).filter(request => request.input !== null)).toHaveLength(0);
  });
  it.each(['success', 'malformed', 'unmatched', 'retired-conflict'] as const)(
    'retains only a matched metadata commit receipt without projecting after semantic withdrawal during ACK consumption (%s)', async ack => {
    const sessionId = 'committed-metadata-before-withdrawal';
    const read = installSession(sessionId, { path: '/private/captured-account', flavor: 'claude' });
    const originalProjection = storage.getState().sessions[sessionId];
    const initialRevision = read().metadataVersion;
    const committed: number[] = [];
    if (ack === 'retired-conflict') {
      const answer = { select: (input: unknown) => input === null || input === undefined
        ? { body: { session: read() } }
        : { status: 409, body: SessionMetadataVersionConflictV1Schema.parse({
          code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
          sharedMetadata: { version: initialRevision + 1 }, agentState: { version: (read().agentStateVersion ?? 0) + 1 },
        }) } };
      homes.answer(serverId, `/v2/sessions/${sessionId}`, answer);
      homes.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, answer);
    }
    const { invalidateAccountEncryptionModeCacheForChanges } = await import('@/sync/api/account/apiAccountEncryptionMode');
    setRuntimeFetch(async (input, init) => {
      const response = await homes.request(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (init?.method !== 'PATCH' || url.pathname !== `/v2/sessions/${sessionId}`) return response;
      // The real Home has committed and returned its strict success envelope.
      // Deliver a semantic wake while the client consumes those ACK bytes.
      const bytes = ack === 'malformed' ? new TextEncoder().encode(JSON.stringify({ success: true }))
        : ack === 'unmatched' ? new TextEncoder().encode(JSON.stringify(SessionMetadataTuplePatchSuccessV1Schema.parse({
          success: true, metadataLayoutVersion: 1, sharedMetadata: { version: initialRevision + 99 },
          agentState: { version: (read().agentStateVersion ?? 0) + 99 },
        }))) : new Uint8Array(await response.arrayBuffer());
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          invalidateAccountEncryptionModeCacheForChanges([{ kind: 'account', entityId: 'self' }], { serverId });
          controller.enqueue(bytes);
          controller.close();
        },
      }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
    });
    try {
      const { sync } = await import('@/sync/sync');
      const publication = sync.patchSessionMetadataWithRetry(sessionId,
        metadata => ({ ...metadata, approvalReviewerEnabled: true }),
        { serverId, onMetadataCommitted: revision => committed.push(revision) },
      );
      if (ack === 'success') {
        await expect(publication).resolves.toBeUndefined();
        expect(committed).toEqual([read().metadataVersion]);
      } else {
        await expect(publication).rejects.toBeInstanceOf(Error);
        expect(committed).toEqual([]);
      }
      expect(read().metadataVersion).toBe(initialRevision + (ack === 'retired-conflict' ? 0 : 1));
      expect(storage.getState().sessions[sessionId]).toBe(originalProjection);
      const requests = homes.requests.filter(request => request.path.split('?')[0] === `/v2/sessions/${sessionId}`);
      expect(requests.filter(request => request.input === null)).toHaveLength(1);
      expect(requests.filter(request => request.input !== null)).toHaveLength(1);
    } finally {
      installHomeGovernanceBoundaries(homes);
    }
  });
  it('resolves a manager selector from the exact authorized Session projection', async () => {
    installSession('manager-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const readWorker = installSession('worker-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const worker = SessionCurrentProjectionRecordV1Schema.parse({ ...readWorker(), manager: { sessionId: 'manager-session' } });
    homes.answer(serverId, '/v2/sessions/worker-session', { body: { session: worker } });
    homes.answer(serverId, '/v2/sessions/worker-session?accessProjectionVersion=1', { body: { session: worker } });
    const result = await createDefaultActionExecutor().execute('session.status.get', {
      sessionId: { selector: 'manager', of: 'worker-session' },
    }, context());
    expect(result).toMatchObject({ ok: true, result: { session: { id: 'manager-session' } } });
  });
  it('controls only the selected check-in revision through its captured Home', async () => {
    installSession('exchange-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const state = { v: 1, observedStarts: 5, pauseAtStarts: null, stopped: false, afterTurns: 5 };
    const observedRevision = 'session-message-row-revision:v1:3';
    homes.answer(serverId, '/v2/sessions/exchange-session/exchanges/original-input', { select: body => {
      if (body === undefined || body === null) return { body: { state, observedRevision } };
      expect(body).toEqual({ control: 'continue_more_10', observedRevision });
      return { status: 409, body: { error: 'exchange_revision_conflict' } };
    } });
    const result = await createDefaultActionExecutor().execute('session.exchange.control', {
      sessionId: 'exchange-session', originInputLocalId: 'original-input', decision: 'continue_more',
    }, context());
    expect(result).toMatchObject({ ok: false, errorCode: 'exchange_revision_conflict' });
    expect(homes.requestsFor('/v2/sessions/exchange-session/exchanges/original-input').map(request => request.input))
      .toEqual([null, { control: 'continue_more_10', observedRevision }]);
  });
  it.each(['continue', 'continue_more_10', 'stop'] as const)('keeps the displayed exchange root/revision for banner %s without silently preparing a newer revision', async control => {
    const { controlSessionExchange } = await import('@/sync/ops/sessions/sessionExchangeActions');
    installSession('banner-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const state = { v: 1 as const, observedStarts: 5, pauseAtStarts: null, stopped: false, afterTurns: 5 };
    const displayed = 'session-message-row-revision:v1:3';
    homes.answer(serverId, '/v2/sessions/banner-session/exchanges/root-1', { select: body => {
      if (body == null) return { body: { state, observedRevision: 'session-message-row-revision:v1:4' } };
      expect(body).toEqual({ control, observedRevision: displayed });
      return { status: 409, body: { error: 'exchange_revision_conflict' } };
    } });
    const result = await controlSessionExchange({ address: { serverId, sessionId: 'banner-session' },
      accountId: 'alice', originInputLocalId: 'root-1', status: { state, observedRevision: displayed } }, control);
    expect(result).toMatchObject({ ok: false, errorCode: 'exchange_revision_conflict' });
    expect(homes.requestsFor('/v2/sessions/banner-session/exchanges/root-1').map(request => request.input))
      .toEqual([{ control, observedRevision: displayed }]);
  });
  it('loads a check-in banner only for the selected original, retaining its observation on failed refresh and dropping it on root change', async () => {
    const { useSessionExchangeControl } = await import('@/hooks/session/useSessionExchangeControl');
    const state = { v: 1 as const, observedStarts: 5, pauseAtStarts: null, stopped: false, afterTurns: 5 };
    let failing = false;
    homes.answer(serverId, '/v2/sessions/banner-session/exchanges/root-1', { select: () => failing
      ? { status: 503, body: {} } : { body: { state, observedRevision: 'session-message-row-revision:v1:3' } } });
    const hook = await renderHook<ReturnType<typeof useSessionExchangeControl>, { root: string | null }>(({ root }) => useSessionExchangeControl({
      serverId, sessionId: 'banner-session' }, root), { initialProps: { root: null } });
    try {
      expect(homes.requestsFor('/v2/sessions/banner-session/exchanges/root-1')).toHaveLength(0);
      await hook.rerender({ root: 'root-1' });
      await flushHookEffects();
      expect(hook.getCurrent()).toMatchObject({ admission: 'check_in', observation: { originInputLocalId: 'root-1',
        address: { serverId, sessionId: 'banner-session' }, status: { observedRevision: 'session-message-row-revision:v1:3' } } });
      const before = hook.getCurrent().observation;
      failing = true;
      await act(async () => { await hook.getCurrent().refresh(); });
      expect(hook.getCurrent()).toMatchObject({ error: 'exchange_unavailable', observation: before });
      await hook.rerender({ root: null });
      expect(hook.getCurrent().observation).toBeNull();
    } finally { await hook.unmount(); }
  });
  it('keeps a newer selected exchange observation when an earlier root control completes late', async () => {
    const { useSessionExchangeControl } = await import('@/hooks/session/useSessionExchangeControl');
    installSession('banner-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const state = { v: 1 as const, observedStarts: 5, pauseAtStarts: null, stopped: false, afterTurns: 5 };
    homes.answer(serverId, '/v2/sessions/banner-session/exchanges/root-1', { select: body => ({ body: {
      state, observedRevision: body == null ? 'session-message-row-revision:v1:3' : 'session-message-row-revision:v1:4' } }) });
    homes.answer(serverId, '/v2/sessions/banner-session/exchanges/root-2', { body: { state, observedRevision: 'session-message-row-revision:v1:8' } });
    const hook = await renderHook(({ root }: { root: string }) => useSessionExchangeControl({ serverId, sessionId: 'banner-session' }, root),
      { initialProps: { root: 'root-1' } });
    await vi.waitFor(() => expect(hook.getCurrent().observation?.originInputLocalId).toBe('root-1'));
    const held = holdSessionResponseBody('banner-session', '/exchanges/root-1', 'POST');
    let operation: Promise<unknown> | undefined;
    try {
      await act(async () => { operation = hook.getCurrent().control('continue'); await held.reading; });
      await hook.rerender({ root: 'root-2' });
      await vi.waitFor(() => expect(hook.getCurrent().observation?.originInputLocalId).toBe('root-2'));
      await act(async () => { held.release(); await operation; });
      expect(hook.getCurrent().observation).toMatchObject({ originInputLocalId: 'root-2',
        status: { observedRevision: 'session-message-row-revision:v1:8' } });
    } finally { held.release(); held.restore(); await hook.unmount(); }
  });
  it.each(['ui', 'voice', 'legacy', 'schema_legacy', 'extended_send', 'native_command', 'schema_nested_legacy', 'schema_nested_legacy_none', 'review_send'] as const)('keeps an Ask on the canonical daemon send owner with its exact input and observation intent (%s)', async client => {
    const surface = client === 'voice' ? 'voice' : 'ui';
    const reply = client === 'extended_send' || client === 'native_command' || client === 'schema_nested_legacy_none' || client === 'review_send' ? 'none' : 'wait';
    const withReview = client === 'schema_nested_legacy' || client === 'schema_nested_legacy_none' || client === 'review_send';
    const withStructuredInput = client === 'ui' || client === 'schema_legacy' || withReview;
    const overrides = client === 'extended_send' ? { modelOverride: 'provider/claude-sonnet',
      providerConnectionId: 'pc_01J00000000000000000000000' } : {};
    installSession('ask-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const machine = createMachineFixture({ id: 'machine-a', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({ machines: { 'machine-a': machine }, machineListByServerId: { [serverId]: [machine] } });
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    homes.answer(serverId, '/v1/machines', { body: [{ ...createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' }),
      installationId: 'ask-installation', installationPublicKey: encodeBase64(installation.publicKey),
      ...(client === 'legacy' || client === 'extended_send' || client === 'native_command' ? {} : { operationProtocolCapabilities: { sessionMessageReply: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 }) }] });
    if (client === 'extended_send' || client === 'native_command' || client === 'schema_nested_legacy_none' || client === 'review_send') {
      const sessions = { ...storage.getState().sessions };
      delete sessions['ask-session'];
      storage.setState({ sessions });
      const baseline = createRootLayoutFeaturesResponse();
      const features = createRootLayoutFeaturesResponse({ capabilities: { ...baseline.capabilities,
        session: { ...baseline.capabilities.session, pendingInput: { protocolVersion: 1 } } } });
      const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
      primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
      homes.answer(serverId, '/v2/sessions/ask-session/pending', { select: body => {
        const input = StrictJsonValueSchema.parse(body);
        if (!input || typeof input !== 'object' || !('localId' in input) || !('requestedAction' in input)) throw new Error('Expected Pending input');
        return { body: { requestedAction: input.requestedAction, pending: { localId: input.localId } } };
      } });
    }
    for (const actionId of ['action.spec.get', 'session.message.send'] as const) homes.answer(serverId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { body: { v: 1, token: 'ask-root', binding: { accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 },
        serverIdentityId: 'srv_mode_home', machineId: 'machine-a', installationId: 'ask-installation', custodianAccountId: 'alice',
        accountEncryptionMode: 'plain', actionId, requestId: authorized.envelope.requestId,
        target: authorized.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(authorized.envelope) } } };
    } });
    const definition = actionSpecToActionDefinitionV1(getActionSpec('session.message.send'), { surface, includeOutputSchema: false });
    function withoutAdvertisedReviewMember(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(withoutAdvertisedReviewMember);
      if (value === null || typeof value !== 'object') return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'reviewComments')
        .map(([key, item]) => [key, withoutAdvertisedReviewMember(item)]));
    }
    homes.answer(serverId, '/v1/actions/action.spec.get', { select: body => {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { body: { v: 1, actionId: 'action.spec.get', requestId: authorized.envelope.requestId, execution: { ok: true,
        result: { actionSpec: client === 'schema_legacy' ? { ...definition, inputSchema: { type: 'object', properties: {
          sessionId: { type: 'string' }, message: { type: 'string' }, reply: { enum: ['none', 'wait', 'return'] },
        }, additionalProperties: true } } : client === 'schema_nested_legacy' || client === 'schema_nested_legacy_none'
          ? { ...definition, inputSchema: withoutAdvertisedReviewMember(definition.inputSchema) } : definition } } } };
    } });
    const structuredInput = withReview ? { v: 1 as const,
      reviewComments: { sessionId: 'source-session', comments: [] } }
      : { v: 1 as const, mentions: [{ kind: 'happier.session', ref: 'session:source', token: 'find' }] };
    const outcome = SessionMessageSendResultV1Schema.parse({ status: 'accepted', localId: 'ask-input' });
    let boundaryFailure: unknown;
    homes.answer(serverId, '/v1/actions/session.message.send', { select: body => {
      try {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      if (authorized.envelope.v !== 1) throw new Error('Expected the plain Ask fixture envelope');
      expect(authorized.envelope).toMatchObject({ target: { kind: 'machine', machineId: 'machine-a' }, input: client === 'native_command' ? {
        sessionId: 'ask-session', kind: 'sessionSubagentCommand', command: { kind: 'agent_team_delete', teamId: 'team-1' },
        localId: 'ask-input', idempotencyKey: 'native-command-1',
      } : {
        sessionId: 'ask-session', message: 'What did you find?', reply, localId: 'ask-input', timeoutSeconds: 61,
        requestedAction: { v: 1, kind: 'send_now' },
        ...overrides,
        ...(withStructuredInput ? { structuredInput } : {}),
      } });
      expect(openExternalActionRequesterAccountContextV1({ authorization: authorized.executionAuthorization,
        purpose: { kind: 'external_action' }, machineId: 'machine-a', installationId: 'ask-installation', serverIdentityId: 'srv_mode_home',
        installationPrivateKey: installation.secretKey, includeInvocation: true })).toMatchObject({ invocation: {
          caller: { kind: 'host' }, surface, authority: surface === 'voice' ? 'account_automation' : 'present_user' } });
      return { body: { v: 1, actionId: 'session.message.send', requestId: authorized.envelope.requestId, execution: { ok: true, result: outcome } } };
      } catch (error) { boundaryFailure = error; throw error; }
    } });
    const input = client === 'native_command' ? {
      sessionId: 'ask-session', kind: 'sessionSubagentCommand', command: { kind: 'agent_team_delete', teamId: 'team-1' },
      localId: 'ask-input', idempotencyKey: 'native-command-1',
    } as const : {
      sessionId: 'ask-session', message: 'What did you find?', reply, localId: 'ask-input', timeoutSeconds: 61,
      requestedAction: { v: 1, kind: 'send_now' },
      ...overrides,
      ...(withStructuredInput ? { structuredInput } : {}),
    } as const;
    const result = surface === 'voice'
      ? JSON.parse(await (await import('@/voice/tools/handlers')).createVoiceToolHandlers({
          resolveSessionId: explicit => explicit ?? 'origin-session', currentSessionAddress: { serverId, sessionId: 'origin-session' },
        }).action_execute({ actionId: 'session.message.send', input }, { serverId }))
      : await createDefaultActionExecutor().execute('session.message.send', input, context());
    if (client === 'legacy' || client === 'schema_legacy' || client === 'schema_nested_legacy' || client === 'schema_nested_legacy_none') {
      expect(result).toMatchObject({ ok: false, errorCode: 'session_input_target_update_required' });
      expect(homes.requestsFor('/v1/actions/session.message.send')).toHaveLength(0);
      expect(homes.requestsFor('/v2/sessions/ask-session/pending')).toHaveLength(0);
      expect(outgoing.some(request => request.method.endsWith(RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CLAIM))).toBe(false);
      return;
    }
    expect(boundaryFailure).toBeUndefined();
    expect(result, JSON.stringify(homes.requestsFor('/v1/actions/session.message.send').map(request => request.path))).toEqual({ ok: true, result: outcome });
    expect(homes.requestsFor('/v1/actions/session.message.send')).toHaveLength(1);
    expect(homes.requestsFor('/v2/sessions/ask-session/pending')).toHaveLength(0);
  });
  it('inspects an exact continuation through the selected Session daemon', async () => {
    installSession('inspect-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const machine = createMachineFixture({ id: 'machine-a', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({ machines: { 'machine-a': machine }, machineListByServerId: { [serverId]: [machine] } });
    const selection = { v: 1, agentId: 'codex' };
    daemonAnswer = () => ({ type: 'available', protocolVersion: 1, sameSessionTransition: true });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, agentSwitching: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const result = await createDefaultActionExecutor().execute('session.continuation.inspect', { sessionId: 'inspect-session', selection }, context());
    expect(result, JSON.stringify(result))
      .toMatchObject({ ok: true, result: { status: 'answered', inspection: { type: 'available' } } });
    expect(outgoing).toEqual([{ method: `machine-a:${RPC_METHODS.SESSION_CONTINUATION_INSPECT}`,
      params: { v: 1, sourceSessionId: 'inspect-session', selection } }]);
  });
  it('switches through the same Session daemon without replacing the exact first input', async () => {
    installSession('switch-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const machine = createMachineFixture({ id: 'machine-a', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState({ machines: { 'machine-a': machine }, machineListByServerId: { [serverId]: [machine] } });
    const selection = { v: 1, agentId: 'codex' };
    const request = { sessionId: 'switch-session', expectedCurrentAgentId: 'claude', selection,
      input: { localId: 'retained-input', text: 'Expanded prompt', meta: { displayText: 'Attachment', reasoningEffort: 'high' } } };
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    homes.answer(serverId, '/v1/machines', { body: [{ id: 'machine-a', kind: 'persistent', active: true,
      installationId: 'switch-installation', installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null,
      replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
      access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }] });
    let transitionInput: unknown;
    homes.answer(serverId, '/v1/actions/session.agent.transition/execution-authorization', { select: body => {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      return { body: { v: 1, token: 'switch-root', binding: { accountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 },
        serverIdentityId: 'srv_mode_home', machineId: 'machine-a', installationId: 'switch-installation', custodianAccountId: 'alice',
        accountEncryptionMode: 'plain', actionId: 'session.agent.transition', requestId: authorized.envelope.requestId,
        target: authorized.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(authorized.envelope) } } };
    } });
    homes.answer(serverId, '/v1/actions/session.agent.transition', { select: body => {
      const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      if (authorized.envelope.v !== 1) throw new Error('Expected the plain transition fixture envelope');
      expect(authorized.machineId).toBe('machine-a');
      expect(openExternalActionRequesterAccountContextV1({ authorization: authorized.executionAuthorization,
        purpose: { kind: 'external_action' }, machineId: 'machine-a', installationId: 'switch-installation', serverIdentityId: 'srv_mode_home',
        installationPrivateKey: installation.secretKey, includeInvocation: true })).toMatchObject({ invocation: {
          caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' } });
      transitionInput = authorized.envelope.input;
      return { body: { v: 1, actionId: 'session.agent.transition', requestId: authorized.envelope.requestId,
        execution: { ok: true, result: { type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' } } } };
    } });
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, agentSwitching: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    daemonAnswer = rpc => rpc.method.endsWith(RPC_METHODS.SESSION_CONTINUATION_INSPECT)
      ? { type: 'available', protocolVersion: 1, sameSessionTransition: true }
      : { type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' };
    const execute = createDefaultActionExecutor().execute;
    expect(await execute('session.continuation.inspect', { sessionId: request.sessionId, selection }, context()))
      .toMatchObject({ ok: true, result: { status: 'answered', inspection: { type: 'available' } } });
    const switched = await execute('session.agent.transition', request, context());
    expect(switched, JSON.stringify(switched))
      .toEqual({ ok: true, result: { type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' } });
    expect(outgoing.map(rpc => rpc.method)).toEqual([`machine-a:${RPC_METHODS.SESSION_CONTINUATION_INSPECT}`]);
    expect(transitionInput).toEqual(request);
    expect(storage.getState().sessions['switch-session']?.metadata?.flavor).toBe('claude');
  });
  it.each([false, true])('executes goal get, wake and clear through the selected Session daemon (active: %s, no native controls)', async (active) => {
    installSession('goal-session', { path: '/repo', machineId: 'machine-a', flavor: 'codex', codexSessionId: 'native-thread' });
    const session = storage.getState().sessions['goal-session'];
    storage.setState({ sessions: { ...storage.getState().sessions, 'goal-session': { ...session, active } },
      machines: { ...storage.getState().machines, 'machine-a': createMachineFixture({ id: 'machine-a',
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: { ...createMachineFixture().metadata!, host: 'goal.test', daemonSessionGoalControlsSupported: true } }) } });
    daemonAnswer = request => {
      const schema = request.method.endsWith(RPC_METHODS.DAEMON_SESSION_GOAL_GET) ? DaemonSessionGoalGetRequestV1Schema
        : request.method.endsWith(RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR) ? DaemonSessionGoalClearRequestV1Schema
          : DaemonSessionGoalSetRequestV2Schema;
      expect(schema.parse(request.params)).toMatchObject({ sessionId: 'goal-session' });
      return { workState: null };
    };
    const executor = createDefaultActionExecutor();
    const goalGet = await executor.execute('session.goal.get', { sessionId: 'goal-session' }, context());
    expect(goalGet, JSON.stringify(goalGet))
      .toMatchObject({ ok: true, result: { workState: null } });
    expect(await executor.execute('session.goal.set', { sessionId: 'goal-session', objective: 'Finish the task', tokenBudget: null }, context()))
      .toMatchObject({ ok: true });
    expect(await executor.execute('session.goal.clear', { sessionId: 'goal-session' }, context()))
      .toMatchObject({ ok: true });
    expect(outgoing.map(request => request.method)).toEqual([
      `machine-a:${RPC_METHODS.DAEMON_SESSION_GOAL_GET}`, 'machine-a:daemon.sessionGoal.set.v2',
      `machine-a:${RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR}`,
    ]);
    expect(outgoing[1]?.params).toMatchObject({ sessionId: 'goal-session', objective: 'Finish the task',
      tokenBudget: null, resumeInactiveWithInitialGoal: true });
  });
  it('retains admitted Goal operations beyond the generic Machine RPC acknowledgement cutoff', async () => {
    installSession('goal-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ machines: { ...storage.getState().machines, 'machine-a': createMachineFixture({ id: 'machine-a',
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: { ...createMachineFixture().metadata!, daemonSessionGoalControlsSupported: true } }) } });
    const executor = createDefaultActionExecutor();
    vi.useFakeTimers();
    try {
      for (const actionId of ['session.goal.set', 'session.goal.get', 'session.goal.clear'] as const) {
        let acknowledge!: (value: unknown) => void;
        daemonAnswer = () => new Promise(resolve => { acknowledge = resolve; });
        let settled = false;
        const signal = new AbortController().signal;
        const pending = executor.execute(actionId, { sessionId: 'goal-session',
          ...(actionId === 'session.goal.set' ? { objective: 'Finish the task' } : {}) }, { ...context(), signal })
          .then(result => { settled = true; return result; });
        await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
        // The daemon may still be preparing or publishing the native Goal.
        // Its admitted receipt belongs to this operation, even after the
        // transport's unqualified 30-second default would have elapsed.
        await vi.advanceTimersByTimeAsync(31_000);
        expect(settled, actionId).toBe(false);
        acknowledge({ workState: null });
        expect(await pending).toMatchObject({ ok: true, result: actionId === 'session.goal.get'
          ? { workState: null } : { ok: true } });
      }
      let acknowledge!: (value: unknown) => void;
      daemonAnswer = () => new Promise(resolve => { acknowledge = resolve; });
      const abort = new AbortController();
      const cancelled = executor.execute('session.goal.get', { sessionId: 'goal-session' }, { ...context(), signal: abort.signal });
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
      const cancellation = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
      abort.abort();
      await cancellation;
    } finally {
      vi.useRealTimers();
    }
  });
  it('retires a signal-free Goal Action wait with its captured Account', async () => {
    installSession('goal-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ machines: { ...storage.getState().machines, 'machine-a': createMachineFixture({ id: 'machine-a',
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      metadata: { ...createMachineFixture().metadata!, daemonSessionGoalControlsSupported: true } }) } });
    let acknowledge!: (value: unknown) => void;
    daemonAnswer = () => new Promise(resolve => { acknowledge = resolve; });
    let settled = false;
    const pending = createDefaultActionExecutor().execute('session.goal.get', { sessionId: 'goal-session' }, context())
      .then(value => { settled = true; return value; }, error => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
      const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
      await disconnectActiveServerConnection();
      await vi.waitFor(() => expect(settled, 'Account retirement must release its Goal wait').toBe(true));
    } finally {
      acknowledge?.({ workState: null });
      await pending.catch(() => {});
    }
  });
  it('preserves definitive API-token send outcomes at the transcript boundary', async () => {
    const read = installSession('external-send', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    if (!connection) throw new Error('Missing connected Home fixture');
    const { sync } = await import('@/sync/sync');
    const { getCurrentAuth, setCurrentAuth } = await import('@/auth/context/currentAuth');
    const http = await import('@/sync/http/client');
    const previousAuth = getCurrentAuth();
    let outcome = SessionMessageSendResultV1Schema.parse({ status: 'accepted', localId: 'real-input' });
    const sentInputs: unknown[] = [];
    // The endpoint HTTP adapter is the genuine boundary. Scope lifetime,
    // bootstrap, public Action transport, output parsing and the source stay real.
    vi.spyOn(http, 'createServerFetchAtEndpoint').mockImplementation(({ endpointUrl }) => async (path: string, init?: RequestInit) => {
      const url = new URL(path, endpointUrl);
      if (url.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
      if (url.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
      if (url.pathname === '/v2/sessions/external-send') return Response.json({ session: read() });
      if (url.pathname === '/v1/sessions/external-send/turns') return Response.json({ v: 1, sessionId: 'external-send', updatedAt: 1, turns: [] });
      if (url.pathname === '/v1/sessions/external-send/messages') return Response.json({ messages: [], hasMore: false });
      if (url.pathname === '/v2/sessions/external-send/pending') return Response.json({ pending: [], count: 0, version: 0 });
      if (url.pathname === '/v1/actions/session.message.send') {
        sentInputs.push(typeof init?.body === 'string' ? JSON.parse(init.body) : null);
        return Response.json({ v: 1, actionId: 'session.message.send', execution: { ok: true, result: outcome } });
      }
      if (url.pathname === '/v1/actions/session.permission_mode.set') {
        return Response.json({ v: 1, actionId: 'session.permission_mode.set', execution: {
          ok: false, errorCode: 'unsupported_action', error: 'endpoint-owned-refusal',
        } });
      }
      throw new Error(`Unexpected embed HTTP request: ${url.pathname}`);
    });
    const refuseCredentialMutation = async (): Promise<never> => { throw new Error('Injected credential'); };
    setCurrentAuth({ isAuthenticated: true, credentials: connection.credentials, credentialAuthorityKind: 'api_token',
      login: refuseCredentialMutation, loginWithCredentials: refuseCredentialMutation, logout: refuseCredentialMutation,
      refreshFromActiveServer: async () => {} });
    try {
      // An embed frame starts with its own Session projection, not the main
      // app's profile-id-addressed row for the same Session identifier.
      storage.setState({ sessions: {} });
      await sync.create(connection.credentials, null, undefined, { scope: { kind: 'embedSession', sessionId: 'external-send' },
        accountId: 'alice', endpointUrl: 'https://mode-actions.test', accountMode: 'plain', isCurrent: () => true });
      const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
      const actions = createAppSessionTranscriptActions('external-send', serverId);
      for (const result of [
        { status: 'rejected', code: 'session_input_unauthorized' },
        { status: 'failed', localId: 'real-input', code: 'session_input_turn_failed' },
        { status: 'cancelled', localId: 'real-input', code: 'session_input_turn_cancelled' },
      ]) {
        outcome = SessionMessageSendResultV1Schema.parse(result);
        await expect(actions.submitMessage('Message')).rejects.toMatchObject({ code: result.code, details: outcome });
      }
      outcome = SessionMessageSendResultV1Schema.parse({ status: 'accepted', localId: 'real-input' });
      await expect(actions.submitMessage('Message', { permissionModeOverride: 'read-only' })).resolves.toBeUndefined();
      expect(sentInputs.at(-1)).toMatchObject({ input: { permissionModeOverride: 'read-only' } });
      const { submitAppSessionComposerMessage } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
      const { createSyncBackedSubmitPort } = await import('@/sync/domains/session/input/syncBackedSubmitPort');
      let handedOff = false;
      const composerOptions = { sessionId: 'external-send', serverId,
        session: createSessionFixture({ id: 'external-send', serverId }), text: 'Composer message',
        configuredMode: 'agent_queue' as const, resumeCapabilityOptions: {}, metaOverrides: { permissionMode: 'read-only' },
        onOutboundHandoff: () => { handedOff = true; } };
      outcome = SessionMessageSendResultV1Schema.parse({ status: 'outcomeUnknown', localId: 'real-input', code: 'session_input_pending' });
      expect(await submitAppSessionComposerMessage(createSyncBackedSubmitPort(sync), composerOptions))
        .toMatchObject({ type: 'rejected', persistence: 'none' });
      expect(handedOff).toBe(false);
      outcome = SessionMessageSendResultV1Schema.parse({ status: 'alreadyAccepted', localId: 'real-input' });
      expect(await submitAppSessionComposerMessage(createSyncBackedSubmitPort(sync), composerOptions))
        .toMatchObject({ type: 'success', localId: 'real-input' });
      expect(handedOff).toBe(true);
      expect(sentInputs.at(-1)).toMatchObject({ input: { permissionModeOverride: 'read-only' } });
      const composerExecutor = createDefaultActionExecutor({ sessionMessageComposerSubmission: {
        sourceComposerRef: { kind: 'session', sessionId: 'source-composer' }, isCurrent: () => true,
      } });
      const attachment = ComposerAttachmentDraftV1Schema.parse({ v: 1, instanceId: 'media-attachment',
        attachment: { pluginId: 'com.example.media', localId: 'image' }, key: 'photo', value: {},
        presentation: { label: 'Photo', typeLabel: 'Image' }, content: { kind: 'stagedMedia', handle: {
          v: 1, id: 'captured-source-media', executionTarget: { serverId, machineId: 'source-machine' },
          owner: { pluginId: 'com.example.media', localId: 'image' }, mediaKind: 'image', mimeType: 'image/png',
          name: 'photo.png', sizeBytes: 7, sha256: 'a'.repeat(64),
        } } });
      const composerInput = { sessionId: 'external-send', message: 'Targeted media', localId: 'composer-token-input',
        structuredInput: { composerAttachments: [attachment] } };
      const inputsBeforePrivateComposer = sentInputs.length;
      const executed = await composerExecutor.execute('session.message.send', composerInput, { surface: 'ui' });
      const prepared = await composerExecutor.prepare('session.message.send', composerInput, { surface: 'ui' });
      expect({ executed, prepared }).toMatchObject({
        executed: { ok: false, errorCode: 'session_input_target_unavailable' },
        prepared: { kind: 'settled', result: { ok: false, errorCode: 'session_input_target_unavailable' } },
      });
      expect(sentInputs.slice(inputsBeforePrivateComposer)).toEqual([]);
      expect(await composerExecutor.execute('session.permission_mode.set', {
        sessionId: 'external-send', permissionMode: 'read-only',
      }, { surface: 'ui' })).toEqual({ ok: false, errorCode: 'unsupported_action', error: 'endpoint-owned-refusal' });
    } finally {
      sync.disposeEmbedSession();
      setCurrentAuth(previousAuth);
    }
  });
  it('refuses a disabled stop through the shared lifecycle adapter used by single and bulk commands', async () => {
    installSession('stop-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    installActionSettings({ 'session.stop': { disabledSurfaces: ['ui'] } });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    expect(await executeSessionLifecycleAction('session.stop', 'stop-session', { serverId }))
      .toMatchObject({ success: false });
    expect(outgoing).toEqual([]);
  });
  it('preserves current daemon stop confirmation and failure detail through the real Action adapter', async () => {
    const readRow = installSession('stop-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');

    daemonAnswer = () => {
      const row = readRow();
      const envelope = SessionOwnerMetadataEnvelopeV1Schema.parse(row.ownerMetadata);
      expect(envelope.t).toBe('plain');
      if (envelope.t !== 'plain') throw new Error('Expected plain owner metadata');
      expect(readSessionExplicitStopV1FromMetadata(envelope.v.runtime)).toMatchObject({
        v: 1, cause: 'explicit_stop', requestId: expect.any(String), requestedAtMs: expect.any(Number),
      });
      return { status: 'stopped' };
    };
    await expect(executeSessionLifecycleAction('session.stop', 'stop-session', { serverId }))
      .resolves.toEqual({ success: true });
    const publicStop = await createDefaultActionExecutor().execute('session.stop', { sessionId: 'stop-session' }, context());
    expect(publicStop).toMatchObject({ ok: true, result: { success: true } });
    if (!publicStop.ok) throw new Error('Expected confirmed Stop');
    expect(SessionStopResultSchema.parse(publicStop.result)).toMatchObject({ sessionId: 'stop-session', stopped: true });
    expect(outgoing).toContainEqual(expect.objectContaining({
      method: `machine-a:${RPC_METHODS.STOP_SESSION}`,
      params: { sessionId: 'stop-session' },
    }));

    outgoing.length = 0;
    daemonAnswer = () => ({ status: 'incomplete', reason: 'destroy_failed' });
    await expect(executeSessionLifecycleAction('session.stop', 'stop-session', { serverId }))
      .resolves.toMatchObject({
        success: false,
        code: 'session_stop_failed',
        message: 'Session stop incomplete: destroy_failed',
      });
  });
  it('preserves automatic Stop authorship without creating a person hold through the real Action adapter', async () => {
    const readRow = installSession('automatic-stop', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    daemonAnswer = () => ({ status: 'stopped' });
    const result = await createDefaultActionExecutor().execute('session.stop', { sessionId: 'automatic-stop' }, {
      ...context(), authority: 'account_automation', actionCaller: { kind: 'host' },
    });
    expect(result).toMatchObject({ ok: true, result: { stopped: true, success: true } });
    expect(readRow().metadataLayoutVersion).toBe(0);
    expect(readSessionExplicitStopV1FromMetadata(JSON.parse(readRow().metadata))).toBeNull();
  });
  it.each([true, false])('confirms an already-stopped Session through a fresh Home read after exact daemon absence (cached active=%s)', async (cachedActive) => {
    const sessionId = 'stop-already-inactive';
    const readRow = installSession(sessionId, { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const session = storage.getState().sessions[sessionId];
    storage.setState({ sessions: { ...storage.getState().sessions, [sessionId]: { ...session, active: cachedActive } } });
    let daemonStopReturned = false;
    let freshReads = 0;
    const answer = { select: () => {
      if (daemonStopReturned) freshReads++;
      return { body: { session: { ...readRow(), active: !daemonStopReturned } } };
    } };
    homes.answer(serverId, `GET /v2/sessions/${sessionId}`, answer);
    homes.answer(serverId, `GET /v2/sessions/${sessionId}?accessProjectionVersion=1`, answer);
    daemonAnswer = (request) => {
      if (request.method !== `machine-a:${RPC_METHODS.STOP_SESSION}`) throw new Error('No runner remains to stop');
      daemonStopReturned = true;
      return { status: 'not_found' };
    };
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    await expect(executeSessionLifecycleAction('session.stop', sessionId, { serverId })).resolves.toEqual({ success: true });
    const publicStop = await createDefaultActionExecutor().execute('session.stop', { sessionId }, context());
    expect(publicStop).toMatchObject({ ok: true, result: { success: true } });
    if (!publicStop.ok) throw new Error('Expected already-stopped confirmation');
    const parsed = SessionStopResultSchema.parse(publicStop.result);
    expect(parsed).toMatchObject({ sessionId, stopped: false,
      stopOutcome: { status: 'already_stopped', reason: 'no_runtime_session_inactive' } });
    expect(isSessionStopConfirmed(parsed)).toBe(true);
    expect(freshReads).toBeGreaterThan(0);
    expect(outgoing.map(request => request.method)).toEqual([`machine-a:${RPC_METHODS.STOP_SESSION}`, `machine-a:${RPC_METHODS.STOP_SESSION}`]);
  });

  it.each(['active', 'unknown', 'unavailable', 'ambiguous'] as const)('does not confirm an absent runtime from %s Home or transport evidence', async (evidence) => {
    const sessionId = 'stop-unconfirmed';
    const readRow = installSession(sessionId, { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const session = storage.getState().sessions[sessionId];
    storage.setState({ sessions: { ...storage.getState().sessions, [sessionId]: { ...session, active: false } } });
    let daemonStopReturned = false;
    let confirmationReadFailed = false;
    const answer = { select: () => {
      if (daemonStopReturned && evidence === 'unavailable' && !confirmationReadFailed) {
        confirmationReadFailed = true;
        return { status: 500, body: { error: 'Session projection temporarily unavailable' } };
      }
      return { body: { session: { ...readRow(), active: evidence === 'unknown' && daemonStopReturned ? undefined : evidence !== 'ambiguous' } } };
    } };
    homes.answer(serverId, `GET /v2/sessions/${sessionId}`, answer);
    homes.answer(serverId, `GET /v2/sessions/${sessionId}?accessProjectionVersion=1`, answer);
    daemonAnswer = (request) => {
      if (request.method === `machine-a:${RPC_METHODS.STOP_SESSION}`) {
        daemonStopReturned = true;
        if (evidence === 'ambiguous') throw Object.assign(new Error('Stop acknowledgement lost'), { rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
      }
      if (evidence === 'unavailable' && request.method === `${sessionId}:killSession`) return { status: 'requested' };
      return { status: 'not_found' };
    };
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const result = await executeSessionLifecycleAction('session.stop', sessionId, { serverId });
    expect(result, JSON.stringify(result)).toMatchObject({ success: false,
      ...(evidence === 'unavailable' ? { code: 'session_stop_requested' } : {}) });
    if (evidence === 'unavailable') expect(outgoing.map(request => request.method)).toEqual([
      `machine-a:${RPC_METHODS.STOP_SESSION}`, `${sessionId}:killSession`,
    ]);
    if (evidence === 'ambiguous') expect(outgoing.map(request => request.method)).toEqual([`machine-a:${RPC_METHODS.STOP_SESSION}`]);
  });

  it('retains an explicit Ask policy for Stop after removing UI-local confirmation', async () => {
    installSession('stop-ask', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    installActionSettings({ 'session.stop': { approvalRequiredSurfaces: ['ui'] } });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    await expect(executeSessionLifecycleAction('session.stop', 'stop-ask', { serverId }))
      .resolves.toMatchObject({ success: false, code: 'approval_request_created' });
    expect(outgoing).toEqual([]);
  });
  it('retains next-prompt mode in the draft without invoking the immediate Action', async () => {
    const { applyPermissionModeSelection } = await import('@/sync/domains/permissions/permissionModeApply');
    const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
    const read = installSession('mode-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const draftScope = storage.getState().settingsScope;
    if (!draftScope) throw new Error('Expected the restored Account draft scope');
    await applyPermissionModeSelection({ sessionId: 'mode-session', serverId, mode: 'safe-yolo', applyTiming: 'next_prompt',
      draftScope,
      executeAction: createDefaultActionExecutor().execute });
    expect(storage.getState().sessions['mode-session']?.permissionMode).not.toBe('safe-yolo');
    const retainedDraft = getSessionDraftSnapshot(draftScope, { kind: 'session', sessionId: 'mode-session' });
    if (!retainedDraft || !('extensions' in retainedDraft.document)) throw new Error('Expected Session composer draft');
    expect(retainedDraft.document.extensions.happier?.nextPromptPermissionModeV1?.value).toBe('safe-yolo');
    expect(read().metadataVersion).toBe(1);
    await applyPermissionModeSelection({ sessionId: 'mode-session', serverId, mode: 'read-only', applyTiming: 'immediate',
      draftScope,
      executeAction: createDefaultActionExecutor().execute });
    expect(storage.getState().sessions['mode-session']?.permissionMode).toBe('read-only');
    expect(read().metadataVersion).toBeGreaterThan(1);
  });

  it('refuses disabled transcript permission and answer Actions before reaching the daemon', async () => {
    installSession('prompt-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.getState().updateSessionPermissionMode('prompt-session', 'read-only');
    installActionSettings({
      'session.permission.respond': { disabledSurfaces: ['ui'] },
      'session.user_action.answer': { disabledSurfaces: ['ui'] },
      'session.message.send': { disabledSurfaces: ['ui'] },
    });
    const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
    const actions = createAppSessionTranscriptActions('prompt-session', serverId);
    await expect(actions.respondToPermission({ id: 'p1', approved: true, decision: 'approved_for_session', mode: 'acceptEdits' })).rejects.toThrow();
    await expect(actions.answerUserAction({ id: 'q1', answers: { Question: ['One', 'Two'] } })).rejects.toThrow();
    await expect(actions.submitMessage('Selected option', { callerSurface: 'message_option' })).rejects.toThrow();
    expect(storage.getState().sessions['prompt-session']?.permissionMode).toBe('read-only');
    expect(outgoing).toEqual([]);
  });
  it('preserves permission decisions, client evidence and multi-select answers through transcript Actions', async () => {
    installSession('prompt-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.getState().updateSessionPermissionMode('prompt-session', 'read-only');
    daemonAnswer = () => ({ ok: true });
    const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
    const actions = createAppSessionTranscriptActions('prompt-session', serverId);
    await actions.respondToPermission({ id: 'p1', approved: true, decision: 'approved_for_session', mode: 'acceptEdits' });
    expect(storage.getState().sessions['prompt-session']?.permissionMode).toBe('safe-yolo');
    await actions.answerUserAction({ id: 'q1', answers: { Question: ['One', 'Two'] } });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `prompt-session:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
      params: expect.objectContaining({ id: 'p1', approved: true, decision: 'approved_for_session', mode: 'acceptEdits',
        answeringClientCategory: 'web' }) }));
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `prompt-session:${RPC_METHODS.SESSION_USER_ACTION_ANSWER}`,
      params: expect.objectContaining({ id: 'q1', approved: true, answers: { Question: ['One', 'Two'] },
        answeringClientCategory: 'web' }) }));
  });
  it.each(['ui', 'voice'] as const)('preserves question pass-up through the %s Action authority boundary', async surface => {
    installSession('question-worker', { machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ sessions: { ...storage.getState().sessions, 'question-worker': createSessionFixture({
      ...storage.getState().sessions['question-worker'], agentState: { requests: {
        'question-1': { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ question: 'Which revision?' }] } },
      } },
    }) } });
    daemonAnswer = () => ({ ok: true });
    const input = { sessionId: 'question-worker', requestId: 'question-1', disposition: 'pass_up', reason: 'Needs a person' };
    const result = surface === 'ui'
      ? await createDefaultActionExecutor().execute('session.user_action.answer', input, context())
      : JSON.parse(await (await import('@/voice/tools/handlers')).createVoiceToolHandlers({ resolveSessionId: explicit => explicit ?? null })
        .action_execute!({ actionId: 'session.user_action.answer', input }, { serverId }));
    if (surface === 'voice') {
      // Generic Voice is Account automation, not the authenticated manager exception.
      expect(result).toMatchObject({ ok: false, errorCode: 'present_user_required' });
      expect(outgoing).toEqual([]);
      return;
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(outgoing).toContainEqual({ method: `question-worker:${RPC_METHODS.SESSION_USER_ACTION_ANSWER}`,
      params: { id: 'question-1', disposition: 'pass_up', reason: 'Needs a person' } });
    daemonAnswer = () => ({ ok: false, errorCode: 'present_user_required' });
    const refused = surface === 'ui'
      ? await createDefaultActionExecutor().execute('session.user_action.answer', input, context())
      : JSON.parse(await (await import('@/voice/tools/handlers')).createVoiceToolHandlers({ resolveSessionId: explicit => explicit ?? null })
        .action_execute!({ actionId: 'session.user_action.answer', input }, { serverId }));
    expect(refused).toMatchObject({ ok: false, errorCode: 'present_user_required' });
  });
  it.each(['ui', 'voice'] as const)('publishes exact answer and pass through the %s Action and preserves publisher refusals', async surface => {
    installSession('reply-receiver', { machineId: 'machine-a', flavor: 'claude' });
    const invoke = async (reply: { kind: 'answer'; message: string } | { kind: 'pass' }) => {
      const input = { sessionId: 'reply-receiver', requestLocalId: 'original-input', reply };
      return surface === 'ui'
        ? createDefaultActionExecutor().execute('session.message.reply', input, context())
        : JSON.parse(await (await import('@/voice/tools/handlers')).createVoiceToolHandlers({ resolveSessionId: () => null })
          .action_execute!({ actionId: 'session.message.reply', input }, { serverId }));
    };
    const progress = { v: 1, mode: 'wait', acceptedTurnId: 'accepted-turn', disposition: 'observing', outcome: { kind: 'pass' } };
    daemonAnswer = () => ({ v: 1, ok: true, progress });
    for (const reply of [{ kind: 'answer', message: 'Use revision 42.' }, { kind: 'pass' }] as const) {
      const result = await invoke(reply);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { v: 1, ok: true, progress } });
      expect(outgoing.at(-1)).toEqual({ method: 'reply-receiver:session.message.reply',
        params: { sessionId: 'reply-receiver', requestLocalId: 'original-input', reply } });
    }
    daemonAnswer = () => ({ v: 1, ok: false, error: 'conflict' });
    expect(await invoke({ kind: 'pass' })).toMatchObject({ ok: true, result: { v: 1, ok: false, error: 'conflict' } });
  });
  it.each((['generic', 'question'] as const).flatMap(entry => [
    { entry, response: 'answer' as const }, { entry, response: 'reject' as const },
  ]))('requires person approval before a $entry Voice question $response reaches the sole answer RPC', async ({ entry, response }) => {
    installSession('question-worker', { machineId: 'machine-a', flavor: 'claude' });
    storage.setState({ sessions: { ...storage.getState().sessions, 'question-worker': createSessionFixture({
      ...storage.getState().sessions['question-worker'], agentState: { requests: {
        'question-1': { tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ question: 'Which revision?' }] } },
      } },
    }) } });
    const { ApprovalRequestSchema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
    const tools = (await import('@/voice/tools/handlers')).createVoiceToolHandlers({ resolveSessionId: () => 'question-worker' });
    const input = { sessionId: 'question-worker', requestId: 'question-1', ...(response === 'answer'
      ? { answers: [{ question: 'Which revision?', values: ['42'] }] } : { decision: 'reject' as const }) };
    daemonAnswer = () => ({ ok: true });
    const result = JSON.parse(await (entry === 'generic'
      ? tools.action_execute!({ actionId: 'session.user_action.answer', input }, { serverId, effectId: `voice-answer-${entry}` })
      : tools.answerUserActionRequest!(input, { serverId, effectId: `voice-answer-${entry}` })));
    expect(result, JSON.stringify(result)).toMatchObject(entry === 'generic'
      ? { ok: true, result: { kind: 'approval_request_created' } }
      : { ok: true, kind: 'approval_request_created' });
    expect(outgoing).toEqual([]);
    const approval = homes.artifacts(serverId).list().find(row => {
      const body = homes.artifacts(serverId).readPlainBody(row.id);
      return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
    });
    if (!approval) throw new Error('Voice answer did not create an approval');
    expect(ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(approval.id) ?? 'null')))
      .toMatchObject({ status: 'open', actionId: 'session.user_action.answer', actionArgs: input,
        executionOriginV1: { authority: 'account_automation', surface: 'voice', accountId: 'alice' } });
    // Voice cannot decide its own proposal or gain authority from a settings waiver.
    expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId: approval.id, decision: 'approve' },
      { surface: 'voice', serverId })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(outgoing).toEqual([]);
    const approved = await createDefaultActionExecutor().execute('approval.request.decide',
      { artifactId: approval.id, decision: 'approve' }, context());
    expect(approved, JSON.stringify(approved)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(outgoing).toEqual([{ method: `question-worker:${RPC_METHODS.SESSION_USER_ACTION_ANSWER}`,
      params: { id: 'question-1', approved: response === 'answer',
        ...(response === 'answer' ? { answers: { 'Which revision?': ['42'] } } : {}), answeringClientCategory: 'web' } }]);
    expect(ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(approval.id) ?? 'null')))
      .toMatchObject({ status: 'executed', decision: { kind: 'approve', authority: 'present_user' } });
  });
  it('keeps permission feedback and title state unchanged while explicit UI approval is pending', async () => {
    const read = installSession('approval-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    storage.getState().updateSessionPermissionMode('approval-session', 'read-only');
    installActionSettings({
      'session.permission.respond': { approvalRequiredSurfaces: ['ui'] },
      'session.title.set': { approvalRequiredSurfaces: ['ui'] },
    });
    const { createAppSessionTranscriptActions } = await import('@/components/sessions/transcript/source/appSessionTranscriptActions');
    await expect(createAppSessionTranscriptActions('approval-session', serverId).respondToPermission({
      id: 'p1', approved: true, mode: 'acceptEdits',
    })).rejects.toMatchObject({ code: 'approval_request_created' });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    expect(await executeSessionLifecycleAction('session.title.set', 'approval-session', { serverId }, 'Pending title'))
      .toMatchObject({ success: false, code: 'approval_request_created' });
    expect(storage.getState().sessions['approval-session']?.permissionMode).toBe('read-only');
    expect(read().metadataVersion).toBe(1);
    expect(outgoing).toEqual([]);
  });

  it('refuses disabled session-delete before reaching its HTTP transport', async () => {
    const session = createSessionFixture({ id: 'delete-session', serverId, active: false });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session } });
    installActionSettings({ 'session.delete': { disabledSurfaces: ['ui'] } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    let deleted = false;
    homes.answer(serverId, `/v1/sessions/${session.id}`, { select: () => { deleted = true; return { body: { success: true } }; } });
    await expect(executeSessionAction({ actionId: 'ui.session.delete', target: createSessionActionTarget({ session, serverId,
      currentUserId: 'alice', isConnected: true, isPinned: false }) })).rejects.toThrow();
    expect(deleted).toBe(false);
  });
  it('executes an Info-confirmed Delete through the real Action front door without creating another approval', async () => {
    const session = createSessionFixture({ id: 'confirmed-delete-session', serverId, active: false, archivedAt: 42 });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session } });
    let deleteRequests = 0;
    homes.answer(serverId, `/v1/sessions/${session.id}`, { select: () => {
      deleteRequests += 1;
      return { body: { success: true } };
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');

    await expect(executeSessionAction({
      actionId: 'ui.session.delete',
      target: createSessionActionTarget({ session, serverId, currentUserId: 'alice', isConnected: false, isPinned: false }),
      context: { presentUserConfirmation: { actionId: 'session.delete' } },
    })).resolves.toBeUndefined();
    expect(deleteRequests).toBe(1);
  });
  it('retains the Home delete conflict payload at the UI error boundary', async () => {
    const session = createSessionFixture({ id: 'conflict-session', serverId, active: false });
    storage.setState({ sessions: { ...storage.getState().sessions, [session.id]: session } });
    const details = { error: 'Session delete condition was lost' };
    homes.answer(serverId, `/v1/sessions/${session.id}`, { status: 409, body: details });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    await expect(executeSessionAction({ actionId: 'ui.session.delete', target: createSessionActionTarget({ session,
      serverId, currentUserId: 'alice', isConnected: true, isPinned: false }) }))
      .rejects.toMatchObject({ code: 'session_delete_conflict', details, message: details.error });
  });
  it.each(['ui.session.archive', 'ui.session.unarchive', 'ui.session.rename'] as const)(
    'refuses disabled sibling %s before mutating the selected Session', async (actionId) => {
      const read = installSession('sibling-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
      const disabled = actionId === 'ui.session.rename' ? 'session.title.set'
        : actionId === 'ui.session.archive' ? 'session.archive' : 'session.unarchive';
      installActionSettings({
        [disabled]: { disabledSurfaces: ['ui'] },
      });
      let wroteArchive = false;
      homes.answer(serverId, '/v2/sessions/sibling-session/archive', { select: () => {
        wroteArchive = true; return { body: { success: true, archivedAt: 10 } };
      } });
      homes.answer(serverId, '/v2/sessions/sibling-session/unarchive', { select: () => {
        wroteArchive = true; return { body: { success: true, archivedAt: null } };
      } });
      const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
      const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
      const session = { ...storage.getState().sessions['sibling-session']!, active: false };
      await expect(executeSessionAction({ actionId, input: { title: 'Refused title' }, target: createSessionActionTarget({
        session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false,
      }) })).rejects.toThrow();
      expect(wroteArchive).toBe(false);
      expect(read().metadataVersion).toBe(1);
    },
  );
  it('keeps the owned archive timeout code and uses the translated UI failure through the real Action front door', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const session = createSessionFixture({ id: 'archive-timeout-localized', serverId, owner: 'alice', active: false, archivedAt: null });
    storage.getState().applySessions([session]);
    const row = createPlainSessionCurrentProjectionRecordFixture({ id: session.id, active: false });
    homes.answer(serverId, `/v2/sessions/${session.id}`, { body: { session: row } });
    const entered = createDeferred<void>();
    const response = createDeferred<void>();
    homes.answer(serverId, `/v2/sessions/${session.id}/archive`, { select: () => {
      entered.resolve(); return { body: { success: true, archivedAt: 42 }, respondAfter: response.promise };
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { t } = await import('@/text');
    vi.useFakeTimers();
    const pending = executeSessionAction({ actionId: 'ui.session.archive', target: createSessionActionTarget({
      session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false,
    }) }).then(() => null, (error: unknown) => error);
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(75_000);
      expect(await pending).toMatchObject({ code: 'session_archive_timeout', message: t('sessionInfo.failedToArchiveSession') });
      expect(storage.getState().sessionArchiveOperations).toEqual({});
      expect(storage.getState().sessions[session.id]?.archivedAt).toBeNull();
    } finally {
      response.resolve();
      await pending;
      vi.useRealTimers();
    }
  });

  it('shares archive progress and admission with a report archived by the real Action cascade', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const leadId = 'admitted-cascade-lead';
    const childId = 'admitted-cascade-child';
    const sessions = [leadId, childId].map(id => createSessionFixture({
      id, serverId, owner: 'alice', active: false, archivedAt: null,
    }));
    storage.getState().applySessions(sessions);
    const rows = sessions.map(session => createPlainSessionCurrentProjectionRecordFixture({
      id: session.id, active: false,
      ...(session.id === childId ? { manager: { sessionId: leadId } } : {}),
    }));
    const releaseChild = createDeferred<void>();
    let childArchiveRequests = 0;
    for (const row of rows) {
      homes.answer(serverId, `/v2/sessions/${row.id}`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}?accessProjectionVersion=1`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}/archive`, { select: () => {
        if (row.id === childId) childArchiveRequests += 1;
        return { body: { success: true, archivedAt: 42 },
          ...(row.id === childId ? { respondAfter: releaseChild.promise } : {}) };
      } });
    }
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
      expect(SessionListQueryV1Schema.parse(input).underSessionId).toBe(leadId);
      return { body: SessionListQueryResponseV1Schema.parse({
        sessions: [{ ...rows[1], viewer: createSessionViewerFixture() }],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { isSessionArchivePending } = await import('@/components/sessions/sessionStopArchiveFlow');
    const target = (session: typeof sessions[number]) => createSessionActionTarget({
      session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false,
    });
    const cascade = executeSessionAction({ actionId: 'ui.session.archive', target: target(sessions[0]!),
      input: { alsoArchiveReports: true } });
    let duplicate: Promise<void | false> | undefined;
    let duplicateSettled = false;
    let duplicateSkipped = false;
    try {
      await vi.waitFor(() => expect(childArchiveRequests).toBe(1));
      const childPending = isSessionArchivePending({ serverId, sessionId: childId });
      duplicate = executeSessionAction({ actionId: 'ui.session.archive', target: target(sessions[1]!) })
        .then(result => { duplicateSettled = true; duplicateSkipped = result === false; return result; });
      await vi.waitFor(() => expect(duplicateSettled || childArchiveRequests > 1).toBe(true));
      expect({ childPending, childArchiveRequests, duplicateSkipped })
        .toEqual({ childPending: true, childArchiveRequests: 1, duplicateSkipped: true });
    } finally {
      releaseChild.resolve();
      await Promise.all([cascade, duplicate]);
    }
    expect(storage.getState().sessionArchiveOperations).toEqual({});
  });

  it('keeps an active report Stop inside shared archive admission', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const leadId = 'admitted-stop-lead';
    const childId = 'admitted-stop-child';
    const lead = createSessionFixture({ id: leadId, serverId, owner: 'alice', active: false, archivedAt: null });
    storage.getState().applySessions([lead]);
    const readChild = installSession(childId, { machineId: 'machine-a', flavor: 'claude' });
    const child = storage.getState().sessions[childId]!;
    const leadRow = createPlainSessionCurrentProjectionRecordFixture({ id: leadId, active: false });
    homes.answer(serverId, `/v2/sessions/${leadId}`, { body: { session: leadRow } });
    homes.answer(serverId, `/v2/sessions/${leadId}?accessProjectionVersion=1`, { body: { session: leadRow } });
    for (const id of [leadId, childId]) {
      homes.answer(serverId, `/v2/sessions/${id}/archive`, { body: { success: true, archivedAt: 42 } });
    }
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
      expect(SessionListQueryV1Schema.parse(input).underSessionId).toBe(leadId);
      return { body: SessionListQueryResponseV1Schema.parse({
        sessions: [{ ...readChild(), manager: { sessionId: leadId }, viewer: createSessionViewerFixture() }],
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
    } });
    const releaseStop = createDeferred<void>();
    let childStopRequests = 0;
    daemonAnswer = async request => {
      if (request.method !== `machine-a:${RPC_METHODS.STOP_SESSION}`) throw new Error(`Unexpected daemon method: ${request.method}`);
      expect(request.params).toMatchObject({ sessionId: childId });
      childStopRequests += 1;
      await releaseStop.promise;
      return { status: 'stopped' };
    };
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { isSessionArchivePending } = await import('@/components/sessions/sessionStopArchiveFlow');
    const target = (session: typeof lead) => createSessionActionTarget({
      session, serverId, currentUserId: 'alice', isConnected: true, isPinned: false,
    });
    const cascade = executeSessionAction({ actionId: 'ui.session.archive', target: target(lead),
      input: { alsoArchiveReports: true } });
    let duplicate: Promise<void | false> | undefined;
    let duplicateSettled = false;
    let duplicateSkipped = false;
    try {
      await vi.waitFor(() => expect(childStopRequests).toBe(1));
      const childPending = isSessionArchivePending({ serverId, sessionId: childId });
      duplicate = executeSessionAction({ actionId: 'ui.session.archive', target: target(child) })
        .then(result => { duplicateSettled = true; duplicateSkipped = result === false; return result; });
      await vi.waitFor(() => expect(duplicateSettled || childStopRequests > 1).toBe(true));
      expect({ childPending, childStopRequests, duplicateSkipped })
        .toEqual({ childPending: true, childStopRequests: 1, duplicateSkipped: true });
    } finally {
      releaseStop.resolve();
      await Promise.all([cascade, duplicate]);
    }
    expect(storage.getState().sessionArchiveOperations).toEqual({});
  });

  it.each(['ui', 'action'] as const)('ends a completed report archive while another report is still pending (%s)', async (entry) => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const leadId = 'settled-report-lead';
    const firstId = 'settled-report-first';
    const secondId = 'settled-report-second';
    const sessions = [leadId, firstId, secondId].map(id => createSessionFixture({
      id, serverId, owner: 'alice', active: false, archivedAt: null,
    }));
    storage.getState().applySessions(sessions);
    const rows = sessions.map(session => createPlainSessionCurrentProjectionRecordFixture({
      id: session.id, active: false, ...(session.id === leadId ? {} : { manager: { sessionId: leadId } }),
    }));
    const releaseSecond = createDeferred<void>();
    let secondArchiveRequests = 0;
    for (const row of rows) {
      homes.answer(serverId, `/v2/sessions/${row.id}`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}?accessProjectionVersion=1`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}/archive`, { select: () => {
        if (row.id === secondId) secondArchiveRequests += 1;
        return { body: { success: true, archivedAt: 42 },
          ...(row.id === secondId ? { respondAfter: releaseSecond.promise } : {}) };
      } });
    }
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
      expect(SessionListQueryV1Schema.parse(input).underSessionId).toBe(leadId);
      return { body: SessionListQueryResponseV1Schema.parse({
        sessions: rows.slice(1).map(row => ({ ...row, viewer: createSessionViewerFixture() })),
        nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
      }) };
    } });
    const { createSessionActionTarget } = await import('@/components/sessions/actions/sessionActionContext');
    const { executeSessionAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const { isSessionArchivePending } = await import('@/components/sessions/sessionStopArchiveFlow');
    const cascade = entry === 'ui'
      ? executeSessionAction({ actionId: 'ui.session.archive', input: { alsoArchiveReports: true },
        target: createSessionActionTarget({ session: sessions[0]!, serverId, currentUserId: 'alice', isConnected: true, isPinned: false }) })
      : createDefaultActionExecutor().execute('session.archive', { sessionId: leadId, alsoArchiveReports: true }, context());
    try {
      await vi.waitFor(() => expect(secondArchiveRequests).toBe(1));
      expect({ lead: isSessionArchivePending({ serverId, sessionId: leadId }),
        first: isSessionArchivePending({ serverId, sessionId: firstId }),
        second: isSessionArchivePending({ serverId, sessionId: secondId }) }).toEqual({ lead: true, first: false, second: true });
    } finally {
      releaseSecond.resolve();
      await cascade;
    }
    expect(storage.getState().sessionArchiveOperations).toEqual({});
  });

  it('borrows an inherited archive proof after its Home identity is promoted', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const serverUrl = 'https://archive-proof-promotion.test';
    const legacyId = await homes.addHome({ name: 'Archive proof Home', serverUrl, accountId: 'alice', active: false,
      credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) } });
    // The focused Account restore's single-origin boundary does not own this remote Home.
    installHomeGovernanceBoundaries(homes);
    homes.answer(legacyId, '/v2/account/settings', { body: { content: { t: 'plain', v: storage.getState().settings }, version: 1 } });
    const sessionId = 'promoted-archive-proof';
    const row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: false });
    homes.answer(legacyId, `/v2/sessions/${sessionId}`, { body: { session: row } });
    homes.answer(legacyId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { body: { session: row } });
    const releaseArchive = createDeferred<void>();
    let archiveRequests = 0;
    homes.answer(legacyId, `/v2/sessions/${sessionId}/archive`, { select: () => {
      archiveRequests += 1;
      return { body: { success: true, archivedAt: 42 }, respondAfter: releaseArchive.promise };
    } });
    const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    const { archiveSessionWithPendingState } = await import('@/components/sessions/sessionStopArchiveFlow');
    const canonicalId = 'srv_archive_proof_promoted';
    const pending = archiveSessionWithPendingState({ serverId: legacyId, sessionId }, async operation => {
      expect(operation.serverId).toBe(legacyId);
      await setServerProfileIdentityForUrl(serverUrl, canonicalId);
      const result = await createDefaultActionExecutor().execute('session.archive', { sessionId }, {
        surface: 'ui', serverId: canonicalId, archiveOperation: operation,
      });
      // The inner Action borrows the exact proof; its caller still owns completion.
      expect(storage.getState().sessionArchiveOperations[legacyId]?.[sessionId]).toBe(operation);
      return result;
    }).then(result => ({ result }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(archiveRequests).toBe(1));
    } finally {
      releaseArchive.resolve();
      const outcome = await pending;
      if ('error' in outcome) throw outcome.error;
    }
    const outcome = await pending;
    if ('error' in outcome) throw outcome.error;
    expect(outcome.result).toMatchObject({ ok: true, result: { success: true, sessionId } });
    expect(archiveRequests).toBe(1);
    expect(storage.getState().sessionArchiveOperations).toEqual({});
  });

  it('refuses a retired archive proof without borrowing or finishing its replacement', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const sessionId = 'retired-archive-proof';
    const session = createSessionFixture({ id: sessionId, serverId, owner: 'alice', active: false, archivedAt: null });
    storage.getState().applySessions([session]);
    const row = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: false });
    homes.answer(serverId, `/v2/sessions/${sessionId}`, { body: { session: row } });
    homes.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { body: { session: row } });
    const address = { serverId, sessionId };
    const retired = storage.getState().beginSessionArchive(address);
    if (!retired) throw new Error('Expected initial archive admission');
    storage.getState().clearSessionArchiveOperations(serverId);
    const replacement = storage.getState().beginSessionArchive(address);
    if (!replacement) throw new Error('Expected replacement archive admission');
    let archiveRequests = 0;
    homes.answer(serverId, `/v2/sessions/${sessionId}/archive`, { select: () => {
      archiveRequests += 1;
      return { body: { success: true, archivedAt: 42 } };
    } });
    try {
      const result = await createDefaultActionExecutor().execute('session.archive', { sessionId }, {
        ...context(), archiveOperation: retired,
      });
      expect(result).toMatchObject({ ok: false, errorCode: 'archive_pending' });
      expect(archiveRequests).toBe(0);
      expect(storage.getState().sessionArchiveOperations[replacement.serverId]?.[sessionId]).toBe(replacement);
    } finally {
      storage.getState().finishSessionArchive(replacement);
    }
  });

  it('composes the archive choice through the real HTTP list/archive owners and strict UI consumer', async () => {
    installActionSettings({ 'session.archive': { disabledSurfaces: [], approvalRequiredSurfaces: [] } });
    const rows = ['cascade-lead', 'cascade-child', 'cascade-refused', 'cascade-last', 'cascade-grandchild'].map(id =>
      createPlainSessionCurrentProjectionRecordFixture({ id, active: false,
        ...(id !== 'cascade-lead' ? { manager: { sessionId: id === 'cascade-grandchild' ? 'cascade-child' : 'cascade-lead' } } : {}),
      }));
    const archived: string[] = [];
    for (const row of rows) {
      homes.answer(serverId, `/v2/sessions/${row.id}`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}?accessProjectionVersion=1`, { body: { session: row } });
      homes.answer(serverId, `/v2/sessions/${row.id}/archive`, { select: () => {
        archived.push(row.id);
        return row.id === 'cascade-refused' ? { status: 403, body: { error: 'Forbidden' } }
          : { body: { success: true, archivedAt: 10 } };
      } });
    }
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
      const query = SessionListQueryV1Schema.parse(input);
      expect(query).toMatchObject({ storage: 'active', underSessionId: 'cascade-lead' });
      return { body: SessionListQueryResponseV1Schema.parse({ sessions: rows.slice(1).map(row => ({
        ...row, viewer: createSessionViewerFixture(),
      })), nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }) };
    } });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');
    const result = await executeSessionLifecycleAction('session.archive', 'cascade-lead', { serverId, alsoArchiveReports: true });
    expect(result, JSON.stringify(result)).toMatchObject({ success: true, sessionId: 'cascade-lead', reports: [
      { sessionId: 'cascade-child', status: 'archived' },
      { sessionId: 'cascade-refused', status: 'failed' },
      { sessionId: 'cascade-last', status: 'archived' },
    ] });
    const archiveOutputSchema = getActionSpec('session.archive')?.outputSchema;
    if (!archiveOutputSchema) throw new Error('Session archive output schema is unavailable');
    expect(archiveOutputSchema.parse(result)).toEqual(result);
    expect(archived).toEqual(['cascade-lead', 'cascade-child', 'cascade-refused', 'cascade-last']);
  });
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    storage.setState(originalState, true);
    await homes.reset();
    resetDynamicModelProbeCacheForTests();
    const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }) };
    serverId = await homes.addHome({ name: 'Mode Home', serverUrl: 'https://mode-actions.test', serverIdentityId: 'srv_mode_home', accountId: 'alice', credentials });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://mode-actions.test', accountId: 'alice', credentials,
      request: homes.request, configureSocket: configureSessionSocket });
    storage.getState().activateProfileScope({ serverId: connection.serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId: connection.serverId, accountId: 'alice' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const machineRow = createPlainMachineRowFixture({ id: 'machine-a', accountId: 'alice' });
    const machine = createMachineFixture({ id: machineRow.id, activeAt: machineRow.activeAt });
    storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
    homes.answer(serverId, '/v1/machines', { body: { machines: [machineRow] } });
    homes.answer(serverId, '/v1/machines/machine-a', { body: { machine: machineRow } });
    homes.answer(serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({ status: 'absent' }) });
    const access = bindMachineAccessActionHttpRequestV1('machines.access.grants.list', { serverId, machineId: machineRow.id });
    homes.answer(serverId, access.path, { body: MachineAccessGrantsListResponseV1Schema.parse({
      machineId: machineRow.id, custodian: machineRow.access!.custodian, access: machineRow.access,
      canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
    }) });
    outgoing.length = 0;
    daemonAnswer = () => { throw new Error('Unexpected daemon request'); };
  });
  afterEach(async () => {
    await connection?.dispose();
    connection = undefined;
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    await homes.reset();
    storage.setState(originalState, true);
    webLocks?.restore();
    webLocks = undefined;
    vi.restoreAllMocks();
  });

  it('limits the real backend catalog instead of dropping the requested limit', async () => {
    const execute = createDefaultActionExecutor().execute;
    const full = await execute('agents.backends.list', { includeDisabled: true }, context());
    const limited = await execute('agents.backends.list', { includeDisabled: true, limit: 2 }, context());
    expect(full.ok, JSON.stringify(full)).toBe(true);
    expect(limited.ok).toBe(true);
    if (!full.ok || !limited.ok) throw new Error('Catalog action failed');
    const parse = (value: unknown) => import('@happier-dev/protocol').then(({ AgentsBackendsListOutputSchema }) => AgentsBackendsListOutputSchema.parse(value));
    expect((await parse(full.result)).items.length).toBeGreaterThan(2);
    expect((await parse(limited.result)).items).toEqual((await parse(full.result)).items.slice(0, 2));
  });

  it.each([
    { agentId: 'claude', machineId: 'machine-a', limit: 3 },
    { backendTargetKey: 'acpBackend:review-bot', machineId: 'machine-a', limit: 2 },
  ])('limits model results from the requested daemon target: $agentId $backendTargetKey', async (input) => {
    daemonAnswer = () => ({ ok: true, result: {
      availableModels: ['one', 'two', 'three', 'four'].map((id) => ({ id, name: id })), supportsFreeform: false,
    } });
    const result = await createDefaultActionExecutor().execute('agents.models.list', input, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { items: expect.any(Array) } });
    if (!result.ok) throw new Error(result.error);
    expect(result.result).toMatchObject({ source: 'preflight', items: [
      { modelId: 'default', label: 'Default' },
      ...['one', 'two'].slice(0, input.limit - 1).map((modelId) => ({ modelId, label: modelId })),
    ] });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: expect.stringContaining('machine-a:'),
      params: expect.objectContaining({ method: 'probeModels' }) }));
    if (input.backendTargetKey) expect(outgoing).toContainEqual(expect.objectContaining({ params: expect.objectContaining({
      params: expect.objectContaining({ backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' } }),
    }) }));
  });

  it('sends the strict V2 spawn input as the daemon wire request', async () => {
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'manual:voice-v2-contract',
      executionTarget: { serverId, machineId: 'machine-a' }, directory: { kind: 'path', path: '/tmp/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      initialInput: { text: 'Inspect this project.' } });
    const spawnResult = { type: 'success', disposition: 'created', sessionId: 'session-new', executionTarget: input.executionTarget,
      organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'accepted', localId: 'message-new' } };
    daemonAnswer = request => request.method === `machine-a:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`
      ? createExistingSessionDirectoryPreflightResult(request.params) : spawnResult;
    const result = await createDefaultActionExecutor().execute('session.spawn_new', input, { ...context(), signal: new AbortController().signal });
    expect(result).toEqual({ ok: true, result: spawnResult });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `machine-a:${RPC_METHODS.SESSION_SPAWN_NEW}`, params: input }));
  });

  it('clears the terminal composer with the expected state at the Session RPC boundary', async () => {
    installSession('s1', { path: '/tmp/project', host: 'localhost', flavor: 'claude' });
    daemonAnswer = () => ({ ok: true, status: 'cleared', sessionId: 's1' });
    const result = await createDefaultActionExecutor().execute('session.terminalComposer.clear',
      { sessionId: 's1', expectedStateAtMs: 1234 }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'cleared', sessionId: 's1' } });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `s1:${SESSION_RPC_METHODS.SESSION_TERMINAL_COMPOSER_CLEAR}`,
      params: { sessionId: 's1', expectedStateAtMs: 1234 } }));
  });

  it('starts a planner run without changing the parent Session mode', async () => {
    const read = installSession('s1', { path: '/tmp/project', host: 'localhost', flavor: 'claude' });
    const accepted = ExecutionRunStartResponseSchema.parse({ runId: 'run_1', callId: 'call_1', sidechainId: 'sidechain_1' });
    daemonAnswer = () => accepted;
    const result = await createDefaultActionExecutor().execute('subagents.plan.start',
      { sessionId: 's1', backendTargetKeys: ['agent:claude'], instructions: 'Plan the changes.' }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { intent: 'plan', results: [{ ok: true, result: accepted }] } });
    expect(outgoing).toContainEqual(expect.objectContaining({ params: expect.objectContaining({
      start: expect.objectContaining({ intent: 'plan', permissionMode: 'read_only' }),
    }) }));
    expect(read().metadataLayoutVersion).toBe(0);
    expect(homes.requestsFor('/v2/sessions/s1').filter((request) => request.input != null)).toEqual([]);
  });

  it.each([
    ['claude', { flavor: 'claude' }, 'plan', 'plan'],
    ['opencode', { flavor: 'opencode', acpSessionModesV1: modes('opencode', 'build', ['build', 'plan']), acpSessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } }, 'default', null],
    ['codex', { flavor: 'codex', sessionModesV1: modes('codex', 'plan', ['default', 'plan']), sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } }, 'default', 'default'],
    ['codebuddy', { flavor: 'codebuddy', sessionModesV1: modes('codebuddy', 'plan', ['default', 'plan']), sessionModeOverrideV1: { v: 1, updatedAt: 5, modeId: 'plan' } }, '', null],
  ] as const)('publishes %s mode intent through the real owner metadata tuple', async (_agent, metadata, modeId, expectedModeId) => {
    const read = installSession('s1', { path: '/tmp/project', host: 'localhost', ...metadata });
    const result = await createDefaultActionExecutor().execute('session.mode.set', { sessionId: 's1', modeId }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(read().metadataLayoutVersion).toBe(1);
    const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
    if (owner.t !== 'plain') throw new Error('Unreadable owner metadata');
    const flat = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v });
    expect(flat.acpSessionModeOverrideV1 ?? flat.sessionModeOverrideV1).toMatchObject({ v: 1, modeId: expectedModeId });
    // The first write migrates to layout 1. The picker must still authorize
    // the next selection from its owner view, as on a replied live Session.
    expect(await createDefaultActionExecutor().execute('session.mode.set', { sessionId: 's1', modeId }, context()))
      .toMatchObject({ ok: true });
  });

  it('rejects an unavailable mode without writing metadata', async () => {
    const read = installSession('s1', { path: '/tmp/project', host: 'localhost', flavor: 'claude' });
    expect(await createDefaultActionExecutor().execute('session.mode.set', { sessionId: 's1', modeId: 'not-a-real-mode' }, context()))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(read().metadataLayoutVersion).toBe(0);
    expect(homes.requestsFor('/v2/sessions/s1').filter((request) => request.input != null)).toEqual([]);
  });

  it('publishes a validated Composer config-option choice through the Action owner', async () => {
    const read = installSession('s1', {
      path: '/tmp/project',
      host: 'localhost',
      flavor: 'opencode',
      sessionConfigOptionsV1: {
        v: 1,
        agentId: 'opencode',
        updatedAt: 1,
        configOptions: [{
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        }],
      },
    });
    const result = await createDefaultActionExecutor().execute('session.config_option.set', {
      sessionId: 's1', configId: 'reasoning_effort', valueId: 'high',
    }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const owner = SessionOwnerMetadataEnvelopeV1Schema.parse(read().ownerMetadata);
    if (owner.t !== 'plain') throw new Error('Unreadable owner metadata');
    const flat = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: JSON.parse(read().metadata), ownerMetadata: owner.v });
    expect(flat.acpConfigOptionOverridesV1).toMatchObject({
      overrides: { reasoning_effort: { value: 'high' } },
    });
  });

  it('rejects an unavailable Composer config-option choice without writing metadata', async () => {
    const read = installSession('s1', {
      path: '/tmp/project', host: 'localhost', flavor: 'opencode',
      sessionConfigOptionsV1: {
        v: 1, agentId: 'opencode', updatedAt: 1,
        configOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }] }],
      },
    });
    expect(await createDefaultActionExecutor().execute('session.config_option.set', {
      sessionId: 's1', configId: 'reasoning_effort', valueId: 'ultra',
    }, context())).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(read().metadataLayoutVersion).toBe(0);
  });


  it('routes a confirmed connected-account chip mutation through its Action owner', async () => {
    daemonAnswer = () => ({ ok: true, action: 'metadata_updated' });
    const input = {
      sessionId: 's1', agentId: 'claude', machineId: 'machine-a', serverId,
      bindings: { v: 2 as const, bindingsByServiceId: {} },
    };
    const result = await createDefaultActionExecutor().execute(
      'session.connected_services_auth.set',
      input,
      { ...context(), presentUserConfirmation: { actionId: 'session.connected_services_auth.set' } },
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, action: 'metadata_updated' } });
    expect(outgoing).toContainEqual(expect.objectContaining({
      method: `machine-a:${RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH}`,
      params: expect.objectContaining({ sessionId: 's1', agentId: 'claude', bindings: input.bindings }),
    }));
  });

  it.each([
    { runtimeDescriptorV1: { v: 1, agentId: 'opencode', agent: { backendMode: 'server', providerSessionId: 'oc_1', serverBaseUrl: 'http://127.0.0.1:4096/', serverBaseUrlExplicit: true } } },
    { agentRuntimeDescriptorV1: { v: 1, agentId: 'opencode', provider: { backendMode: 'server', providerSessionId: 'oc_1', serverBaseUrl: 'http://127.0.0.1:4096/', serverBaseUrlExplicit: true } } },
  ] as const)('resolves ACP modes and default from the canonical or supported deployed runtime carrier', async (descriptor) => {
    installSession('s1', { path: '/tmp/project', host: 'localhost',
      ...descriptor,
      acpSessionModesV1: modes('opencode', 'build', ['build', 'plan']) });
    const result = await createDefaultActionExecutor().execute('action.options.resolve',
      { actionId: 'session.mode.set', fieldPath: 'modeId', sessionId: 's1' }, context());
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { options: expect.arrayContaining([
      expect.objectContaining({ value: 'default' }), expect.objectContaining({ value: 'build' }), expect.objectContaining({ value: 'plan' }),
    ]) } });
  });
});
