import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { ExecutionRunStartResponseSchema, SessionCurrentProjectionRecordV1Schema, SessionMetadataTuplePatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema, MACHINE_PLAIN_DATA_KEY_MARKER,
  SessionSpawnNewInputV2Schema, SessionOwnerMetadataEnvelopeV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { bindMachineAccessActionHttpRequestV1, normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions';

// A real product platform is required for executing-client evidence. The
// generic Node RN stub intentionally has no client category.
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
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
installDisconnectedServerSocketBoundary((socket) => {
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
    return { ok: true, result: daemonAnswer(request) };
  });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
afterAll(restoreExecutorModuleLoader);
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const originalState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId = '';
let webLocks: ReturnType<typeof installWebLockManagerMock> | undefined;

function installSession(id: string, partialMetadata: Partial<NonNullable<ReturnType<typeof createSessionFixture>['metadata']>>) {
  const metadata = { path: '/repo', host: 'tester.local', ...partialMetadata };
  const session = createSessionFixture({ id, serverId, active: true, metadata });
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
  homes.answer(serverId, `/v2/sessions/${id}`, answer);
  homes.answer(serverId, `/v2/sessions/${id}?accessProjectionVersion=1`, answer);
  return () => row;
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
    expect(switched, JSON.stringify(homes.requests.map(({ path }) => path)))
      .toEqual({ ok: true, result: { type: 'rejected', code: 'unsupported_operation', sourceEffect: 'none' } });
    expect(outgoing.map(rpc => rpc.method)).toEqual([`machine-a:${RPC_METHODS.SESSION_CONTINUATION_INSPECT}`]);
    expect(transitionInput).toEqual(request);
    expect(storage.getState().sessions['switch-session']?.metadata?.flavor).toBe('claude');
  });
  it('executes goal get, wake and clear through the selected Session daemon', async () => {
    installSession('goal-session', { path: '/repo', machineId: 'machine-a', flavor: 'codex', codexSessionId: 'native-thread' });
    const session = storage.getState().sessions['goal-session'];
    storage.setState({ sessions: { ...storage.getState().sessions, 'goal-session': { ...session, active: false } },
      machines: { ...storage.getState().machines, 'machine-a': createMachineFixture({ id: 'machine-a',
        storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        metadata: { host: 'goal.test', daemonSessionGoalControlsSupported: true } }) } });
    daemonAnswer = () => ({ workState: null });
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
    vi.spyOn(http, 'createServerFetchAtEndpoint').mockImplementation(({ endpointUrl }) => async (path, init) => {
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
    installSession('stop-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    const { executeSessionLifecycleAction } = await import('@/components/sessions/actions/sessionActionExecution');

    daemonAnswer = () => ({ status: 'stopped' });
    await expect(executeSessionLifecycleAction('session.stop', 'stop-session', { serverId }))
      .resolves.toEqual({ success: true });
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
  it('retains next-prompt mode in the draft without invoking the immediate Action', async () => {
    const { applyPermissionModeSelection } = await import('@/sync/domains/permissions/permissionModeApply');
    const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
    await (await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage')).prepareSessionDraftPersistenceStorage();
    const read = installSession('mode-session', { path: '/repo', machineId: 'machine-a', flavor: 'claude' });
    await applyPermissionModeSelection({ sessionId: 'mode-session', serverId, mode: 'safe-yolo', applyTiming: 'next_prompt',
      draftScope: { serverId, accountId: 'alice' },
      executeAction: createDefaultActionExecutor().execute });
    expect(storage.getState().sessions['mode-session']?.permissionMode).not.toBe('safe-yolo');
    const retainedDraft = getSessionDraftSnapshot({ serverId, accountId: 'alice' }, { kind: 'session', sessionId: 'mode-session' });
    if (!retainedDraft || !('extensions' in retainedDraft.document)) throw new Error('Expected Session composer draft');
    expect(retainedDraft.document.extensions.happier?.nextPromptPermissionModeV1?.value).toBe('safe-yolo');
    expect(read().metadataVersion).toBe(1);
    await applyPermissionModeSelection({ sessionId: 'mode-session', serverId, mode: 'read-only', applyTiming: 'immediate',
      draftScope: { serverId, accountId: 'alice' },
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
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    storage.setState(originalState, true);
    await homes.reset();
    resetDynamicModelProbeCacheForTests();
    const credentials = { token: createAccountTokenForTests('alice', { currentAccount: true }) };
    serverId = await homes.addHome({ name: 'Mode Home', serverUrl: 'https://mode-actions.test', serverIdentityId: 'srv_mode_home', accountId: 'alice', credentials });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://mode-actions.test', accountId: 'alice', credentials, request: homes.request });
    storage.getState().activateProfileScope({ serverId, accountId: 'alice' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'alice' });
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
    daemonAnswer = () => spawnResult;
    const result = await createDefaultActionExecutor().execute('session.spawn_new', input, { ...context(), signal: new AbortController().signal });
    expect(result).toEqual({ ok: true, result: spawnResult });
    expect(outgoing).toContainEqual(expect.objectContaining({ method: `machine-a:${RPC_METHODS.SESSION_SPAWN_NEW}`, params: input }));
  });

  it('clears the terminal composer with the expected state at the Session RPC boundary', async () => {
    installSession('s1', { path: '/tmp/project', host: 'localhost', flavor: 'claude' });
    daemonAnswer = () => ({ ok: true, status: 'cleared', sessionId: 's1' });
    expect(await createDefaultActionExecutor().execute('session.terminalComposer.clear',
      { sessionId: 's1', expectedStateAtMs: 1234 }, context())).toMatchObject({ ok: true, result: { status: 'cleared', sessionId: 's1' } });
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
