import * as React from 'react';
import type { Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ScopeActionOutputSchemas } from '@happier-dev/protocol/actions/scopeActionFamily';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps, RPC_METHODS, UiActionDispatchRequestV1Schema, ActionIdSchema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionDetailAccessProjectionQuery } from '@/sync/api/session/sessionDetailAccessProjection';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { createLocalConversationVoiceAdapter } from '@/voice/adapters/localConversation/localConversationAdapter';
import { getVoiceAdapterRegistry, registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
// The cross-package daemon dispatcher can import Socket before the UI installs
// its transport; every consumer must retain the same canonical boundary.
vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: navigation }).module;
});

const clientSockets: Socket[] = [];
installDisconnectedServerSocketBoundary(socket => { clientSockets.push(socket); });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storage');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
await loadSyncSingletonForTests();
const { createFindSurfaceRegistry } = await import('@/keyboard/findSurfaceRegistry');
const { registerFindActionRuntime } = await import('@/keyboard/findActionRuntime');
const { registerPendingNavigationRuntime } = await import('@/activity/source/pendingNavigationRuntime');
const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
const { createWorkspaceState, createWorkspaceEmptyTab } = await import('@/components/appShell/workspace/workspaceState');
const { projectWorkspaceTabsList } = await import('@/components/appShell/workspace/workspaceActions');
const { createClientActionReverseDispatcher } = await import('../../../../../cli/src/session/actions/clientActionReverseDispatch');
const { listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { readNewSessionDraftProjectionFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { createUiClientActionReverseHandler } = await import('./clientActionReverseDispatch');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const releases: (() => void)[] = [];
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
beforeEach(async () => {
  clientSockets.length = 0;
  await homes.reset();
  serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://relay.test', accountId: 'relay-account' });
  connection = await restoreServerAccountForTest({ serverUrl: 'https://relay.test', accountId: 'relay-account', request: homes.request });
  installHomeGovernanceBoundaries(homes);
  const features = createRootLayoutFeaturesResponse();
  if (!tryWriteServerEnabledBitInPlace(features, 'sessions.following', true)) throw new Error('Following feature is undeclared');
  homes.answer(serverId, '/v1/features', { body: features });
  homes.answer(serverId, '/v1/features/authenticated', { body: features });
  const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
  primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
  storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) } });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  standardCleanup();
  if (connection) { await connection.dispose(); connection = null; installHomeGovernanceBoundaries(homes); }
});

describe('admitted app Actions and daemon-to-app continuations', () => {
  it('routes driver Library Actions through the mounted client registration and strict receiver', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const { useWorkflowLibraryView } = await import('@/components/workflows/library/useWorkflowLibraryView');
    const rows: Parameters<typeof useWorkflowLibraryView>[0] = [];
    function LibraryOwner() {
      useWorkflowLibraryView(rows, null, true);
      return null;
    }
    const machine = createMachineFixture({ id: 'driver-machine', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    await act(async () => {
      storage.setState(state => ({ ...state, profile: { ...state.profile!, id: 'relay-account' },
        machines: { [machine.id]: machine }, machineListByServerId: {} }));
    });
    const socket = clientSockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
    if (!socket) throw new Error('Account transport did not install its reverse receiver');
    const registered = new Set<string>();
    // Socket.IO delivery is the external boundary. Production Runtime registration,
    // ApiSocket decoding, both Action executors and the Library controller stay real.
    vi.mocked(socket.emit).mockImplementation((event, ...args) => {
      const payload: unknown = args[0];
      if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
        if (event === SOCKET_RPC_EVENTS.REGISTER) registered.add(payload.method);
        if (event === SOCKET_RPC_EVENTS.UNREGISTER) registered.delete(payload.method);
      }
      return socket;
    });
    const reverse = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => registered.has(`${machine.id}:${method}`),
      callConnectedClientRpc: async (method, payload, options) => {
        const wire = UiActionDispatchRequestV1Schema.parse(JSON.parse(JSON.stringify(payload)));
        options.onIssued();
        const result = await new Promise<unknown>(resolve => {
          for (const receive of socket.listeners(SOCKET_RPC_EVENTS.REQUEST)) {
            receive({ method: `${machine.id}:${method}`, params: wire }, resolve);
          }
        });
        return { ok: true, result };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute: reverse } as unknown as ActionExecutorDeps);
    const context = { surface: 'mcp' as const, authority: 'account_automation' as const,
      defaultSessionId: 'driver-session', defaultSessionMachineId: machine.id };
    const library = await renderScreen(React.createElement(LibraryOwner));
    // A mounted Library alone cannot answer a driver: its client transport must be bound.
    expect(await caller.execute('workflow.library.view.get', {}, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    expect(await caller.execute('home.runtime.get', { force: true }, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    const runtime = await renderScreen(React.createElement(ClientActionReverseRuntime));
    expect(await caller.execute('home.runtime.get', { force: true }, context))
      .toMatchObject({ ok: true, result: { status: 'ready' } });
    expect(await caller.execute('workflow.library.view.get', {}, context)).toEqual({ ok: true,
      result: ScopeActionOutputSchemas['workflow.library.view.get'].parse({ view: 'all', searchQuery: '', offeredViews: ['all'], visibleKeys: [] }) });
    await act(async () => {
      expect(await caller.execute('workflow.library.view.set', { searchQuery: 'QA-FIN35c' }, context))
        .toEqual({ ok: true, result: { ok: true } });
    });
    expect(await caller.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true, result: { searchQuery: 'QA-FIN35c' } });
    await library.unmount();
    expect(await caller.execute('workflow.library.view.get', {}, context))
      .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
    await runtime.unmount();
    expect(await caller.execute('workflow.library.view.get', {}, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
  });
  it('reaches the captured Home registry owner through the public app Settings executor after focus changes', async () => {
    const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const anchor = `homeAdministration.serverSettings.${key}`;
    const otherServerId = await homes.addHome({ name: 'Other', serverUrl: 'https://other.test', accountId: 'other-account', active: false });
    const projection = (value: number) => ({ revision: 3, startedAt: null, entries: [{ key, value,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'home.settings.set': ['ui'] } },
    } }, version: 1 } });
    homes.answer(serverId, '/v1/home/settings/get', { select: async () => {
      await setActiveServerId(otherServerId, { scope: 'device' });
      return { body: projection(600) };
    } });
    homes.answer(serverId, '/v1/home/settings/set', { body: projection(900) });
    const result = await createDefaultActionExecutor().execute('settings.set', { anchor, value: 900 }, {
      surface: 'ui', serverId, expectedAccountId: 'relay-account',
    });
    expect(result).toEqual({ ok: true, result: { anchor, value: 900 } });
    expect(homes.requestsFor('/v1/home/settings/get').map(request => request.serverId)).toEqual([serverId]);
    expect(homes.requestsFor('/v1/home/settings/set')).toEqual([expect.objectContaining({ serverId,
      input: { expectedRevision: 3, values: { [key]: 900 } } })]);
  });
  it.each([
    { owner: 'Home', anchor: 'homeAdministration.serverSettings.HAPPIER_API_CORS_MAX_AGE_SECONDS', value: 900, actionId: 'home.settings.set' },
    { owner: 'Follow', anchor: 'notifications.autoFollowAssigned', value: true, actionId: 'session.follow.preferences.set' },
  ] as const)('never turns an outer Settings-only credential grant into ambient $owner administrative authority', async ({ anchor, value, actionId }) => {
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const projection = (value: number) => ({ revision: 3, startedAt: null, entries: [{ key, value,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] });
    // A legitimate domain policy waiver must not waive the requester's credential grant.
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { [actionId]: ['agent'] },
    });
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1 } });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1,
    } }, version: 1 } });
    homes.answer(serverId, '/v1/home/settings/get', { body: projection(600) });
    homes.answer(serverId, '/v1/home/settings/set', { body: projection(900) });
    const followPath = getActionSpec('session.follow.preferences.get').serverTransport?.path;
    if (!followPath) throw new Error('Follow preference transport is undeclared');
    homes.answer(serverId, `GET ${followPath}`, { body: { assigned: false, direct: true, team: false, group: true } });
    homes.answer(serverId, `PUT ${followPath}`, { body: { assigned: true, direct: true, team: false, group: true } });
    // Home/Follow declarations now execute at their owning host. The strict
    // reverse-dispatch schema rejects them because they are no longer client-placed.
    const caller = createDefaultActionExecutor();
    const result = await caller.execute('settings.set', { anchor, value }, {
      surface: 'agent', authority: 'account_automation', serverId, bypassApprovals: true,
      actionRequestId: 'restricted-settings-root', externalActionCredential: {
        accountId: 'relay-account', principalId: 'limited-principal', credentialId: 'limited-credential',
        grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['settings.set'] } },
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(homes.requestsFor('/v1/home/settings/get')).toEqual([]);
    expect(homes.requestsFor('/v1/home/settings/set')).toEqual([]);
    expect(homes.requestsFor(followPath)).toEqual([]);
    expect(homes.artifacts(serverId).list()).toEqual([]);
  });
  it.each([
    { anchor: 'homeAdministration.serverSettings.HAPPIER_API_CORS_MAX_AGE_SECONDS', value: 900, ownerId: 'home.settings.set' },
    { anchor: 'notifications.autoFollowAssigned', value: true, ownerId: 'session.follow.preferences.set' },
  ] as const)('routes admitted $ownerId Settings aliases through their captured domain owner', async ({ anchor, value, ownerId }) => {
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const projection = (value: number) => ({ revision: 3, startedAt: null, entries: [{ key, value,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { [ownerId]: ['ui'] } },
    } }, version: 1 } });
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1, approvalWaivedSurfaces: { [ownerId]: ['ui'] },
    }) } });
    homes.answer(serverId, '/v1/home/settings/get', { body: projection(600) });
    homes.answer(serverId, '/v1/home/settings/set', { body: projection(900) });
    const followPath = getActionSpec('session.follow.preferences.get').serverTransport?.path;
    if (!followPath) throw new Error('Follow preference transport is undeclared');
    homes.answer(serverId, `GET ${followPath}`, { body: { assigned: false, direct: true, team: false, group: true } });
    homes.answer(serverId, `PUT ${followPath}`, { body: { assigned: true, direct: true, team: false, group: true } });
    const caller = createDefaultActionExecutor();
    const result = await caller.execute('settings.set', { anchor, value }, {
      surface: 'ui', authority: 'present_user', serverId, bypassApprovals: true, actionRequestId: 'settings-alias-request',
    });
    expect(result).toEqual({ ok: true, result: { anchor, value } });
    const path = ownerId === 'home.settings.set' ? '/v1/home/settings/set' : followPath;
    expect(homes.requestsFor(path).every(request => request.serverId === serverId)).toBe(true);
    expect(homes.requestsFor(path)).toEqual(expect.arrayContaining([expect.objectContaining({ serverId,
      input: ownerId === 'home.settings.set' ? { expectedRevision: 3, values: { [key]: 900 } }
        : { assigned: true, direct: true, team: false, group: true },
    })]));
  });
  it('returns nested Account Home approval with original requester identity without executing the Home write', async () => {
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const anchor = `homeAdministration.serverSettings.${key}`;
    // UI danger writes are normally direct; this Home policy explicitly requires
    // approval and must survive the outer Settings Action's approved bypass.
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'home.settings.set': { approvalRequiredSurfaces: ['ui'] } },
    });
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1 } });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1,
    } }, version: 1 } });
    homes.answer(serverId, '/v1/home/settings/get', { body: { revision: 3, startedAt: null, entries: [{ key, value: 600,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] } });
    const caller = createDefaultActionExecutor();
    expect(await caller.execute('settings.set', { anchor, value: 900 }, {
      surface: 'ui', authority: 'present_user', serverId, bypassApprovals: true, actionRequestId: 'nested-home-request',
    })).toEqual({ ok: true, result: { kind: 'approval_request_created', actionId: 'home.settings.set', artifactId: expect.any(String) } });
    expect(homes.requestsFor('/v1/home/settings/set')).toEqual([]);
    expect(homes.artifacts(serverId).list()).toHaveLength(1);
    const artifact = homes.artifacts(serverId).list()[0];
    expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!)).toMatchObject({
      executionOriginV1: { requestId: 'nested-home-request', surface: 'ui', authority: 'present_user', caller: { kind: 'host' } },
    });
  });
  it('opens one canonical editable authoring draft through the real answering-client owner', async () => {
    const actionId = ActionIdSchema.parse('session.authoring.open');
    const scope = { serverId, accountId: 'relay-account' };
    const before = listNewSessionDraftProjections(scope).length;
    const sessionsBefore = storage.getState().sessions;
    const receive = createUiClientActionReverseHandler({ ...scope, isCurrent: () => true });
    const result = await receive({ v: 1, actionId, input: { seed: {
      prompt: 'Help me author this checkout.', profileId: 'profile-review',
      placement: { kind: 'exactTarget', serverId, machineId: 'machine-authoring', directory: '/checkout' },
    } }, context: { surface: 'agent', authority: 'account_automation' } }, { signal: new AbortController().signal });
    expect(result).toMatchObject({ v: 1, execution: { ok: true, result: { kind: 'opened', destination: 'newSession' } } });
    const execution = result.execution;
    if (!execution.ok || !('result' in execution)) throw new Error('Authoring did not open');
    const acknowledgement = SessionAuthoringOpenResultV1Schema.parse(execution.result);
    if (acknowledgement.kind !== 'opened') throw new Error('Authoring did not open');
    const draft = readNewSessionDraftProjectionFromRepository({ scope, draftId: acknowledgement.draftId });
    expect(draft?.draft).toMatchObject({
      input: 'Help me author this checkout.', selectedProfileId: 'profile-review',
      selectedMachineId: 'machine-authoring', selectedPath: '/checkout',
    });
    expect(listNewSessionDraftProjections(scope)).toHaveLength(before + 1);
    expect(navigation.push).toHaveBeenLastCalledWith({ pathname: '/new', params: { draftId: acknowledgement.draftId } });
    expect(storage.getState().sessions).toBe(sessionsBefore);
  });
  it.each(['agent', 'mcp'] as const)('executes Find, Next and workspace list through the real app executor on %s', async surface => {
    const find = createFindSurfaceRegistry();
    releases.push(registerFindActionRuntime(find));
    find.register({ surfaceId: 'chat:caller-session', containsFocus: () => true,
      open() {}, isOpen: () => true, isInputFocused: () => true, controller: {
        query: 'private corpus query', options: { regex: false, matchCase: false },
        status: { kind: 'results', current: 0, total: 2, coverage: 'loaded' }, capabilities: { regex: true, stop: true },
        setQuery() {}, setOptions() {}, step() {}, stop() {}, close() {},
      } });
    let navigatedHome: string | null | undefined;
    // The mounted navigation effect is the UI boundary; Account capture, policy,
    // schemas, Action executor and runtime registry above it remain real.
    releases.push(registerPendingNavigationRuntime(async options => {
      navigatedHome = options.expectedServerId; return { status: 'opened' };
    }));
    const state = createWorkspaceState(createWorkspaceEmptyTab('visible-tab'));
    releases.push(registerMountedWorkspaceAction(async ({ actionId }) => {
      if (actionId !== 'workspace.tabs.list') throw new Error('unexpected Action');
      return projectWorkspaceTabsList(state);
    }));
    // Only the network hop is replaced. Both dispatchers and both canonical
    // executors run, including the real credential/store/network testkit.
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    const clientActionExecute = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload).context).toMatchObject({ surface, authority: 'account_automation' });
        options.onIssued();
        return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute } as unknown as ActionExecutorDeps);
    const context = { surface, authority: 'account_automation' as const, defaultSessionId: 'caller-session' };
    expect(await caller.execute('ui.find', { op: 'read' }, context)).toEqual({ ok: true,
      result: { status: 'results', current: 0, total: 2, coverage: 'loaded' } });
    expect(await caller.execute('session.pending.next', {}, context)).toEqual({ ok: true, result: { status: 'opened' } });
    expect(navigatedHome).toBe(serverId);
    expect(await caller.execute('workspace.tabs.list', {}, context)).toEqual({ ok: true, result: projectWorkspaceTabsList(state) });
  });

  it.each(['ui', 'agent', 'mcp'] as const)('reuses a same-Home Voice carrier through the admitted client continuation on %s', async (surface) => {
    const previousAdapters = getVoiceAdapterRegistry().list();
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    releases.push(() => registerVoiceAdapters(previousAdapters));
    const rootId = 'teleport-root';
    const carrierId = 'teleport-carrier';
    const machine = createMachineFixture({ id: 'teleport-machine', activeAt: Date.now() });
    const voice = voiceSettingsParse({ providerId: 'local_conversation', providers: {
      local_conversation: { schemaVersion: 1, config: {
        conversationMode: 'agent', agent: { stayInVoiceHome: false, teleportEnabled: true },
      } },
    } });
    const previousVoice = storage.getState().settings.voice;
    releases.push(() => storage.setState(state => ({ settings: { ...state.settings, voice: previousVoice } })));
    storage.setState(state => ({ ...state,
      settings: { ...state.settings, voice },
      machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] },
    }));
    const metadata = { path: '/Users/tester/project', homeDir: '/Users/tester',
      host: 'tester.local', machineId: machine.id };
    const carrierMetadata = { ...metadata,
      systemSessionV1: { v: 1 as const, key: 'voice_conversation', hidden: true },
      voiceConversationScopeV1: { v: 1 as const, kind: 'session_root' as const, sessionRootId: rootId },
    };
    storage.getState().applySessions([
      createSessionFixture({ id: rootId, serverId, metadata }),
      createSessionFixture({ id: carrierId, serverId, metadata: carrierMetadata }),
    ]);
    let carrier = createPlainSessionCurrentProjectionRecordFixture({ id: carrierId, metadata: carrierMetadata });
    const carrierPath = `/v2/sessions/${carrierId}`;
    homes.answer(serverId, `GET ${carrierPath}${buildSessionDetailAccessProjectionQuery(serverId)}`, { select: () => ({ body: { session: carrier } }) });
    homes.answer(serverId, `PATCH ${carrierPath}`, { select: input => {
      // Only the Home's HTTP tuple storage/ACK is replaced; Sync's parser,
      // privacy projection, binding and carrier custody remain real.
      const patch = SessionMetadataTuplePatchV1Schema.parse(input);
      if (patch.mode !== 'owner') throw new Error('Expected an owner metadata tuple');
      expect(patch.sharedMetadata.expectedVersion).toBe(carrier.metadataVersion);
      expect(patch.agentState.expectedVersion).toBe(carrier.agentStateVersion);
      carrier = { ...carrier, metadata: patch.sharedMetadata.ciphertext,
        metadataVersion: carrier.metadataVersion + 1, ownerMetadata: patch.ownerMetadata,
        agentState: patch.agentState.ciphertext, agentStateVersion: carrier.agentStateVersion + 1 };
      return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true,
        metadataLayoutVersion: 1, sharedMetadata: { version: carrier.metadataVersion },
        agentState: { version: carrier.agentStateVersion } }) };
    } });
    releases.push(() => voiceSessionBindingStore.getState().unbind(carrierId));
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    const clientActionExecute = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        options.onIssued();
        return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute });
    const result = await caller.execute('ui.voice_agent.teleport', { sessionId: rootId },
      { surface, authority: surface === 'ui' ? 'present_user' : 'account_automation',
        ...(surface === 'agent' ? { defaultSessionId: rootId } : {}) });
    expect(result)
      .toEqual({ ok: true, result: { ok: true, sessionId: rootId } });
    expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID))
      .toMatchObject({ conversationSessionAddress: { serverId, sessionId: carrierId },
        targetSessionAddress: { serverId, sessionId: rootId } });
    expect(carrier.metadataVersion).toBeGreaterThan(1);
    expect(homes.requestsFor(carrierPath).every(request => request.serverId === serverId)).toBe(true);
    if (surface === 'agent') {
      const committedVersion = carrier.metadataVersion;
      storage.getState().applySessions([createSessionFixture({ id: 'another-root', serverId, metadata })]);
      expect(await caller.execute('ui.voice_agent.teleport', { sessionId: 'another-root' }, {
        surface, authority: 'account_automation', defaultSessionId: rootId,
      })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      expect(homes.requests.some(request => request.path.startsWith('/v2/sessions/another-root'))).toBe(false);
      expect(carrier.metadataVersion).toBe(committedVersion);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)?.targetSessionAddress)
        .toEqual({ serverId, sessionId: rootId });
    }
  });

  it('refuses Voice teleport before carrier publication when the target, provider, binding or relay is unavailable', async () => {
    const previousVoice = storage.getState().settings.voice;
    releases.push(() => storage.setState(state => ({ settings: { ...state.settings, voice: previousVoice } })));
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    const connected = () => ({
      hasConnectedClientRpcHandler: (method: string) => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method: string, payload: unknown, options: { onIssued(): void; signal?: AbortSignal }) => {
        options.onIssued();
        return { ok: true as const, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
      },
    });
    const caller = createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(connected) });
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    expect(await caller.execute('ui.voice_agent.teleport', {}, context)).toMatchObject({ ok: false, errorCode: 'session_not_selected' });
    for (const [agent, code] of [
      [{ stayInVoiceHome: false, teleportEnabled: false }, 'VOICE_TELEPORT_DISABLED'],
      [{ stayInVoiceHome: true, teleportEnabled: true }, 'VOICE_TELEPORT_BLOCKED_BY_HOME'],
    ] as const) {
      storage.setState(state => ({ settings: { ...state.settings, voice: voiceSettingsParse({
        providerId: 'local_conversation', providers: { local_conversation: { schemaVersion: 1,
          config: { conversationMode: 'agent', agent } } },
      }) } }));
      expect(await caller.execute('ui.voice_agent.teleport', { sessionId: 'unbound-root' }, context))
        .toMatchObject({ ok: false, errorCode: code });
    }
    const previousAdapters = getVoiceAdapterRegistry().list();
    registerVoiceAdapters([]);
    releases.push(() => registerVoiceAdapters(previousAdapters));
    storage.setState(state => ({ settings: { ...state.settings, voice: voiceSettingsParse({
      providerId: 'local_conversation', providers: { local_conversation: { schemaVersion: 1,
        config: { conversationMode: 'agent', agent: { stayInVoiceHome: false, teleportEnabled: true } } } },
    }) } }));
    expect(await caller.execute('ui.voice_agent.teleport', { sessionId: 'unbound-root' }, context))
      .toMatchObject({ ok: false, errorCode: 'VOICE_TELEPORT_UNAVAILABLE' });
    storage.setState(state => ({ settings: { ...state.settings, voice: voiceSettingsParse({ providerId: 'off' }) } }));
    expect(await caller.execute('ui.voice_agent.teleport', { sessionId: 'unbound-root' }, context))
      .toMatchObject({ ok: false, errorCode: 'VOICE_TELEPORT_UNAVAILABLE' });
    const unavailable = createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(() => null) });
    expect(await unavailable.execute('ui.voice_agent.teleport', { sessionId: 'unbound-root' }, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable' });
    expect(homes.requests.some(request => request.path.startsWith('/v2/sessions/unbound-root'))).toBe(false);
  });

  it('does not create a second approval at the trusted continuation', async () => {
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, actions: { 'ui.find': { approvalRequiredSurfaces: ['mcp'] } } },
    } }, version: 1 } });
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    expect(await receive({ v: 1, actionId: 'ui.find', input: { op: 'read' }, context: { surface: 'mcp', authority: 'account_automation' } },
      { signal: new AbortController().signal })).toEqual({ v: 1, execution: { ok: true, result: { status: 'noMountedSurface' } } });
    expect(homes.artifacts(serverId).list()).toEqual([]);
  });

  it('refuses a caller-authored bypass or another Account before disclosure', async () => {
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'another-account', isCurrent: () => true });
    const request = { v: 1, actionId: 'ui.find', input: { op: 'read' }, context: { surface: 'agent', authority: 'account_automation' } };
    expect(await receive({ ...request, context: { ...request.context, bypassApprovals: true } }, { signal: new AbortController().signal }))
      .toMatchObject({ execution: { ok: false, errorCode: 'invalid_action_input' } });
    expect(await receive(request, { signal: new AbortController().signal }))
      .toMatchObject({ execution: { ok: false, errorCode: 'action_account_scope_changed' } });
  });

  it('keeps a mounted Machine continuation current when another Machine appears, and retires it on unmount', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const machine = createMachineFixture({ id: 'machine-one' });
    const another = createMachineFixture({ id: 'machine-two' });
    await act(async () => {
      storage.setState(state => ({ ...state, profile: { ...(state.profile ?? {}), id: 'relay-account' },
        machines: { [machine.id]: machine }, machineListByServerId: {} }));
    });
    // Observe the real registry, not a replacement for its retirement behavior.
    const registered = vi.spyOn(apiSocket, 'registerMachineScopedRpcHandler');
    releases.push(() => registered.mockRestore());
    const screen = await renderScreen(React.createElement(ClientActionReverseRuntime));
    const initial = registered.mock.calls.find(([id, method]) => id === machine.id && method === RPC_METHODS.UI_ACTION_EXECUTE);
    if (!initial) throw new Error('Mounted client did not register its Action handler');
    const receive = initial[2];
    const request = { v: 1, actionId: 'ui.find', input: { op: 'read' }, context: { surface: 'agent', authority: 'account_automation' } };
    expect(await receive(request, { signal: new AbortController().signal }))
      .toEqual({ v: 1, execution: { ok: true, result: { status: 'noMountedSurface' } } });
    await act(async () => {
      storage.setState(state => ({ ...state, machines: { [machine.id]: machine, [another.id]: another } }));
    });
    expect(await receive(request, { signal: new AbortController().signal }))
      .toMatchObject({ execution: { ok: true, result: { status: 'noMountedSurface' } } });
    await screen.unmount();
    expect(await receive(request, { signal: new AbortController().signal }))
      .toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
  });
});
