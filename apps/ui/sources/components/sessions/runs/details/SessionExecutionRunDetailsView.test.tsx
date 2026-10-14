import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ExecutionRunCancelTurnRequestSchema, ExecutionRunEnsureRequestSchema, ExecutionRunGetRequestSchema,
    ExecutionRunGetResponseSchema, ExecutionRunPublicStateSchema,
    ExecutionRunStopRequestSchema, FeaturesResponseSchema,
    SessionStoredMessageContentSchema, V2SessionByIdResponseSchema,
    type ExecutionRunPublicState,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';

import { createMachineFixture, createPendingMessageFixture, createSessionFixture, flattenTestStyle,
    renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { serveActionHomes, type ServedHomeRequest } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults, settingsParse } from '@/sync/domains/settings/settings';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { disconnectActiveServerConnection, restoreConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import { ensureSessionDraftRepositoryHydrated, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { SessionParticipantComposer } from '@/components/sessions/participants/composer/SessionParticipantComposer';
import { SessionMessageDetailsView } from '@/components/sessions/transcript/details/SessionMessageDetailsView';
import { ChainTranscriptList } from '@/components/sessions/transcript/ChainTranscriptList';
import { SessionExecutionRunInfoCard } from './SessionExecutionRunInfoCard';
import { SessionExecutionRunDetailsView, type SessionExecutionRunDetailsViewHandle } from './SessionExecutionRunDetailsView';
import { SessionBrowserContextRuntimeProvider, useSessionBrowserContextRuntime,
    type SessionBrowserContextRuntime } from '@/components/sessions/browser/sessionBrowserContextRuntime';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Modal } from '@/modal';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import type { SessionTranscriptSource } from '@/components/sessions/transcript/source/types';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Stack } from '@/components/appShell/workspace/destinationRoute';
import { resolveCompactAppDestinations, useDestinationInstanceTitles } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, values) => values
        ? key + '(' + Object.entries(values).map(([name, value]) => name + '=' + String(value)).join(',') + ')' : key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
const routeBoundary = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => routeBoundary.pathname }).module;
});
vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

const boundary = vi.hoisted(() => {
    const requests: Array<Readonly<{ serverUrl: string; targetId: string; method: string; payload: unknown }>> = [];
    const messages: Array<Readonly<{ serverUrl: string; payload: unknown }>> = [];
    return { call: vi.fn<(method: string, input: unknown) => Promise<unknown>>(), requests, messages };
});
vi.mock('socket.io-client', async () => {
    const { createSocketIoBoundaryStub } = await import('@/dev/testkit/mocks/socketIo');
    return { io: (serverUrl: string) => {
        const { socket } = createSocketIoBoundaryStub();
        socket.emitWithAck.mockImplementation(async (event, raw) => {
            if (event === 'message') boundary.messages.push({ serverUrl, payload: raw });
            if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: ['s1'] };
            if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) {
                throw new Error('Malformed Socket RPC boundary request');
            }
            const separator = raw.method.indexOf(':');
            const method = raw.method.slice(separator + 1);
            boundary.requests.push({ serverUrl, targetId: raw.method.slice(0, separator), method, payload: raw.params });
            return { ok: true, result: await boundary.call(method, raw.params) };
        });
        return socket;
    } };
});
// Only Socket, HTTP, credentials, local persistence and native/browser adapters are replaced.
// App bootstrap, exact Home/Account admission, store, Run operations, roster, transcript,
// composer, state transitions, result projection and rendered controls are all real.
await loadSyncSingletonForTests();

type Screen = Awaited<ReturnType<typeof renderScreen>>;
let screen: Screen;
let home: Awaited<ReturnType<typeof serveActionHomes>>;
let serverId: string;
let sequence = 0;
let runState: ExecutionRunPublicState;
let getReply: () => Promise<unknown>;
let stopReply: () => Promise<unknown>;
let cancelReply: () => Promise<unknown>;
let resumeReply: () => Promise<unknown>;
let latestToolResult: unknown;
let structuredMeta: unknown;
let browserRuntime: SessionBrowserContextRuntime | null = null;
const httpReads: ServedHomeRequest[] = [];
let httpSessionAvailable = true;
const pendingRows: Array<Readonly<{
    localId: string; recipient: { kind: 'execution_run'; runId: string }; messageRole: 'user';
    content: ReturnType<typeof SessionStoredMessageContentSchema.parse>;
    status: 'queued'; position: number; createdAt: number; updatedAt: number;
}>> = [];
const mutationMethods = [SESSION_RPC_METHODS.EXECUTION_RUN_STOP, SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1,
    SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, SESSION_RPC_METHODS.EXECUTION_RUN_SEND];

function createRun(patch: Partial<ExecutionRunPublicState> = {}): ExecutionRunPublicState {
    return ExecutionRunPublicStateSchema.parse({
        runId: 'run_1', callId: 'toolu_1', sidechainId: 'toolu_1', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
        retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'streaming',
        status: 'running', startedAtMs: 1, ...patch,
    });
}
function liveRun(patch: Partial<ExecutionRunPublicState> = {}) {
    return createRun({ runClass: 'long_lived', retentionPolicy: 'resumable',
        lifecycle: { v: 1, state: 'current' }, interaction: {
            kind: 'retained_agent_session.v1', capabilities: { open: ['create', 'resume'], delivery: ['newTurn', 'steer'], cancel: true },
        }, ...patch });
}
function wireResult() {
    return ExecutionRunGetResponseSchema.parse({ run: runState,
        ...(latestToolResult !== undefined ? { latestToolResult } : {}),
        ...(structuredMeta !== undefined ? { structuredMeta } : {}) });
}
function calls(method: string) { return boundary.call.mock.calls.filter(([candidate]) => candidate === method); }
function composer() { return screen.findAllByType(SessionParticipantComposer); }
function info() { return screen.findByType(SessionExecutionRunInfoCard).props; }
async function mount(props: Partial<React.ComponentProps<typeof SessionExecutionRunDetailsView>> = {}, browser = false) {
    function BrowserOwner({ children }: React.PropsWithChildren) {
        const runtime = useSessionBrowserContextRuntime({ enabled: true, sessionId: 's1', scopeKey: serverId });
        browserRuntime = runtime;
        return <SessionBrowserContextRuntimeProvider runtime={runtime}>{children}</SessionBrowserContextRuntimeProvider>;
    }
    const view = <SessionExecutionRunDetailsView sessionId="s1" serverId={serverId} runId="run_1" presentation="panel" {...props} />;
    screen = await renderScreen(browser ? <BrowserOwner>{view}</BrowserOwner> : view);
    return screen;
}
async function loaded() { await vi.waitFor(() => expect(screen.findAllByType(SessionExecutionRunInfoCard)).toHaveLength(1)); }
async function refresh() {
    await act(async () => notifyExecutionRunActivity({ sessionId: 's1', serverId }, { runId: 'run_1' }));
    await vi.waitFor(() => expect(info().run).toEqual(runState));
}
async function menu() {
    await screen.pressByTestIdAsync('session-run-details-actions-menu');
}
function publishMarker(status: ExecutionRunPublicState['status'] = 'running') {
    const marker: NormalizedMessage = {
        id: 'tool-msg-1', localId: null, createdAt: 1, seq: 1, role: 'agent', isSidechain: false,
        content: [{ type: 'tool-call', id: 'toolu_1', name: 'SubAgentRun', description: null,
            uuid: 'run-marker', parentUUID: null, input: {
                runId: 'run_1', backendTarget: runState.backendTarget, intent: runState.intent,
                runClass: runState.runClass, ioMode: runState.ioMode, permissionMode: runState.permissionMode,
                retentionPolicy: runState.retentionPolicy, label: 'Reviewer A',
            } }],
    };
    const result: NormalizedMessage = {
        id: 'tool-result-1', localId: null, createdAt: 2, seq: 2, role: 'agent', isSidechain: false,
        content: [{ type: 'tool-result', tool_use_id: 'toolu_1', content: { ...runState, status },
            is_error: false, uuid: 'run-result', parentUUID: 'run-marker' }],
    };
    getStorage().getState().applyMessages('s1', [marker, result]);
    getStorage().getState().applyMessagesLoaded('s1');
}
let restorePopoverWebGlobals: (() => void) | undefined;
const animationFrames = new Set<ReturnType<typeof setTimeout>>();
beforeEach(async ({ task }) => {
    const commandSuite = task.suite?.name === 'Teammate command Action admission';
    const portableIdentity = commandSuite || task.suite?.name === 'Neighboring user Run Stop admission'
        ? 'srv_run_details_' + (sequence + 1) : undefined;
    const stopPolicy = portableIdentity && task.name.startsWith('refuses ')
        ? { actionsSettingsV1: { v: 1 as const, actions: {
            [commandSuite ? 'session.message.send' : 'execution.run.stop']: {
                enabled: false, enabledPlacements: [], disabledSurfaces: [], disabledPlacements: [],
            },
        } } } : {};
    // A composed real transcript needs browser frames to be asynchronous: the
    // popover-only harness's immediate default recursively re-enters held intent.
    restorePopoverWebGlobals = withPopoverWebGlobals({ frameScheduler: callback => {
        const timer = setTimeout(() => { animationFrames.delete(timer); callback(performance.now()); }, 0);
        animationFrames.add(timer);
        return Number(timer);
    } });
    resetSessionDraftRepositoryForTests();
    browserRuntime = null;
    latestToolResult = undefined;
    structuredMeta = undefined;
    httpSessionAvailable = true;
    pendingRows.length = 0;
    runState = createRun();
    getReply = async () => wireResult();
    stopReply = async () => ({ ok: true });
    cancelReply = async () => ({ ok: true, status: 'requested', runId: 'run_1', occurrenceId: 'occurrence-1', turnId: 'turn-1' });
    resumeReply = async () => ({ ok: true });
    boundary.call.mockReset();
    boundary.requests.length = 0;
    boundary.messages.length = 0;
    boundary.call.mockImplementation(async (method, input) => {
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) { ExecutionRunGetRequestSchema.parse(input); return getReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) { ExecutionRunStopRequestSchema.parse(input); return stopReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1) { ExecutionRunCancelTurnRequestSchema.parse(input); return cancelReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE) { ExecutionRunEnsureRequestSchema.parse(input); return resumeReply(); }
        if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return { runs: [runState] };
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
            'tool.executionRuns': { ok: true, checkedAt: Date.now(), data: { available: true, protocolVersion: 2,
                backends: { codex: { available: true, intents: ['review', 'delegate'] } } } },
        } };
        if (method === RPC_METHODS.STOP_SESSION) return StopSessionResultSchema.parse({ status: 'stopped' });
        if (method === RPC_METHODS.KILL_SESSION) return { status: 'requested' };
        return { errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
    });
    httpReads.length = 0;
    home = await serveActionHomes({
        homes: [{ key: 'home', serverUrl: 'https://run-details-' + (++sequence) + '.test', accountId: 'account-1', settings: stopPolicy }],
        route(request) {
            if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({
                features: { execution: { runs: { enabled: true } }, encryption: { plaintextStorage: { enabled: true }, accountOptOut: { enabled: true } } },
                capabilities: { session: { pendingInput: { protocolVersion: 3 } },
                    ...(portableIdentity ? { serverIdentity: { serverIdentityId: portableIdentity } } : {}),
                    accountStoredContentCompatibility: { v: 1, currentProtocolVersion: 3, minimumProtocolVersion: 3, declarationTransport: 'http-header-and-socket-auth-v1' } },
            }));
            if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (request.path === '/v1/machines') return Response.json([createPlainMachineRowFixture({ id: 'm1', accountId: 'account-1' })]);
            if (request.path === '/v1/machines/m1') return Response.json({ machine: createPlainMachineRowFixture({ id: 'm1', accountId: 'account-1' }) });
            if (request.path === '/v2/sessions/s1' && !httpSessionAvailable) return new Response(null, { status: 404 });
            if (request.path === '/v2/sessions/s1') return Response.json(V2SessionByIdResponseSchema.parse({ session: {
                id: 's1', encryptionMode: 'plain', metadata: JSON.stringify(getStorage().getState().sessions.s1?.metadata ?? {}),
                metadataVersion: 1, agentState: null, agentStateVersion: 1, dataEncryptionKey: null, active: true,
                activeAt: 1, createdAt: 1, updatedAt: 1, seq: 1,
                effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                    capabilities: getStorage().getState().sessions.s1!.access!.capabilities },
                ...(commandSuite ? { pendingVersion: 1, pendingCount: 0 } : {}),
            } }));
            if (request.method === 'POST' && request.path === '/v2/sessions/s1/pending') {
                const body = request.body as Readonly<{ localId: string; requestedAction: unknown }>;
                return Response.json({ requestedAction: body.requestedAction, pending: { localId: body.localId }, didWrite: true });
            }
            if (request.path.includes('/messages') || request.path.includes('/pending')) {
                httpReads.push(request);
                return Response.json(request.path.endsWith('/pending')
                    ? { pending: request.path.includes('/execution-runs/run_1/') ? pendingRows : [],
                        discarded: [], pendingVersion: 1, pendingCount: pendingRows.length }
                    : { messages: [], hasMore: false, nextCursor: null });
            }
            if (request.path === '/v1/artifacts') return Response.json([]);
            return undefined;
        },
    });
    const { resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    if (portableIdentity) await setServerProfileIdentityForUrl(home.homes.home!.serverUrl, portableIdentity);
    serverId = resolveServerProfileScopeIdForIdentifier(home.homes.home!.id);
    await restoreConnectionToActiveServer((await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl))!);
    const machine = createMachineFixture({ id: 'm1', activeAt: Date.now(), storageMode: 'plain' });
    getStorage().setState({
        sessions: { s1: createSessionFixture({ id: 's1', serverId, active: true,
            ...(commandSuite ? { pendingVersion: 1, pendingCount: 0 } : {}),
            metadata: { path: '/repo', host: 'tester.local', machineId: 'm1', flavor: 'codex' } }) },
        machines: { m1: machine }, machineListByServerId: { [serverId]: [machine] },
        sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: true }) },
        sessionPending: { s1: { messages: [], discarded: [], isLoaded: true } },
        settings: settingsParse({ ...settingsDefaults, backendEnabledByTargetKey: {}, ...stopPolicy }),
        settingsScope: { serverId, accountId: 'account-1' }, profileScope: { serverId, accountId: 'account-1' },
    });
    // Scoped interaction and Action admission read the canonical Session list
    // projection, materialized by the same store writer as a hydrated Session.
    getStorage().getState().applySessions([getStorage().getState().sessions.s1!]);
    await ensureSessionDraftRepositoryHydrated({ serverId, accountId: 'account-1' });
});
afterEach(async () => {
    routeBoundary.pathname = '/';
    standardCleanup();
    for (const timer of animationFrames) clearTimeout(timer);
    animationFrames.clear();
    restorePopoverWebGlobals?.();
    await disconnectActiveServerConnection();
    await home?.dispose();
});

describe('SessionExecutionRunDetailsView — real Home, transcript and interaction owners', () => {
    it('publishes the loaded Run identity and its rename to the workspace, not the parent Agents chrome', async () => {
        routeBoundary.pathname = '/session/s1/runs/run_1';
        // The popover fixture supplies measurement, not a browser URL. Install
        // the actual route at the browser boundary before the Provider reads it.
        const events = new EventTarget();
        Object.assign(window, { location: { pathname: routeBoundary.pathname, search: '', hash: '' },
            history: { state: null, pushState: () => {}, replaceState: () => {} }, sessionStorage: { getItem: () => 'main' },
            addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
            dispatchEvent: events.dispatchEvent.bind(events) });
        runState = createRun({ display: { title: 'Reviewer Atlas' } });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
            externalSessions: false, inbox: false, workflows: false, friends: false,
        } });
        function Body(props: Readonly<{ navigation: WorkspaceNavigationContextValue }>) {
            const group = props.navigation.state.groups[props.navigation.state.focusedGroupId];
            const tab = props.navigation.state.tabs[group.activeTabId];
            const entries = React.useMemo(() => [{ key: tab.id, ref: tab.target }], [tab]);
            const titles = useDestinationInstanceTitles(catalog, entries);
            return <>
                {React.createElement('RunTabTitles', { titles, target: tab.target, navigation: props.navigation, tabId: tab.id })}
                <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname={routeBoundary.pathname} focused visible navigation={props.navigation.navigationForTab(tab.id)}>
                    <Stack.Screen options={{ headerTitle: 'Agents' }} />
                    <SessionExecutionRunDetailsView sessionId="s1" serverId={serverId} runId={tab.target.params.runId ?? 'run_1'} presentation="screen" />
                </DestinationInstanceHost>
            </>;
        }
        screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>{navigation => <Body navigation={navigation} />}</WorkspaceProvider>);
        await loaded();
        expect(screen.root.findByType('RunTabTitles').props.target).toMatchObject({ kind: 'sessions',
            params: { workspacePathname: routeBoundary.pathname } });
        const titles = () => [...(screen.root.findByType('RunTabTitles').props.titles as ReadonlyMap<string, string>).values()];
        expect(titles()).toEqual(['Reviewer Atlas']);
        runState = createRun({ display: { title: 'Reviewer renamed' } });
        await refresh();
        expect(titles()).toEqual(['Reviewer renamed']);
        let finishRetarget: ((value: unknown) => void) | undefined;
        getReply = () => new Promise(resolve => { finishRetarget = resolve; });
        const tab = screen.root.findByType('RunTabTitles').props as { navigation: WorkspaceNavigationContextValue; tabId: string };
        await act(async () => { tab.navigation.openHref(`/session/s1/runs/run_2?serverId=${serverId}`, { tabId: tab.tabId }); });
        expect(titles()).toEqual([]);
        if (!finishRetarget) throw new Error('Retarget must start a new exact Run read');
        runState = createRun({ runId: 'run_2', display: { title: 'New exact Run' } });
        await act(async () => { finishRetarget?.(wireResult()); });
        await vi.waitFor(() => expect(titles()).toEqual(['New exact Run']));
    });
    async function mountHistorySource() {
        const source: { current: SessionTranscriptSource | null } = { current: null };
        function Probe() { source.current = useSessionTranscriptSource(); return null; }
        screen = await renderScreen(<AppSessionTranscriptSourceProvider sessionId="s1" serverId={serverId}>
            <Probe />
        </AppSessionTranscriptSourceProvider>);
        if (!source.current?.history.loadOlder) throw new Error('App history must be readable');
        return source.current.history.loadOlder;
    }
    it('hydrates initial app history on the exact Home, then does not refetch loaded exhausted history', async () => {
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: false }) } });
        const loadOlder = await mountHistorySource();
        await act(async () => expect(await loadOlder()).toMatchObject({ status: 'no_more', hasMore: false }));
        const initialReads = httpReads.filter(request => request.path.includes('/messages'));
        expect(initialReads.length).toBeGreaterThan(0);
        expect(initialReads.every(request => request.accountId === 'account-1' && request.home === 'home'
            && request.url.origin === home.homes.home!.serverUrl)).toBe(true);
        const reads = home.requests.length;
        await act(async () => expect(await loadOlder()).toMatchObject({ status: 'no_more', hasMore: false }));
        expect(home.requests).toHaveLength(reads);
    });
    it('fails closed on refused initial app hydration instead of paging a previously exhausted cursor', async () => {
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: false }) } });
        const loadOlder = await mountHistorySource();
        await act(async () => expect(await loadOlder()).toMatchObject({ status: 'no_more' }));
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: false }) } });
        httpSessionAvailable = false;
        httpReads.length = 0;
        await act(async () => expect(await loadOlder()).toMatchObject({ status: 'not_ready', hasMore: true }));
        expect(httpReads.filter(request => request.path.includes('/messages'))).toEqual([]);
    });
    it('reads the Run waiting on a person from the real roster, rather than Run status alone', async () => {
        const question = createToolCallMessageFixture({ id: 'question', tool: {
            id: 'question-tool', name: 'AskUserQuestion', state: 'running', input: {}, createdAt: 1,
            startedAt: 1, completedAt: null, description: null,
            permission: { id: 'question-permission', status: 'pending', kind: 'user_action' },
        } });
        const marker = createToolCallMessageFixture({ id: 'tool-msg-1', tool: {
            id: 'toolu_1', name: 'SubAgentRun', state: 'running', input: { ...runState, label: 'Reviewer A' },
            createdAt: 1, startedAt: 1, completedAt: null, description: null,
        }, children: [question] });
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: [marker.id], messagesById: { [marker.id]: marker } }) } });
        await mount(); await loaded();
        expect(info().attention).toMatchObject({ label: 'sessionAgentActivity.attention.userAction' });
    });
    it('renders the actual info and tool transcript under the app Session source, carrying mounted browser context', async () => {
        publishMarker();
        await mount({}, true); await loaded();
        const details = screen.findByType(SessionMessageDetailsView);
        expect(info().run).toMatchObject({ runId: 'run_1', backendTarget: runState.backendTarget });
        expect(boundary.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toEqual(
            expect.arrayContaining([expect.objectContaining({ serverUrl: home.homes.home!.serverUrl, targetId: 's1',
                payload: { runId: 'run_1', includeStructured: true } })]),
        );
        expect(details.props).toMatchObject({ sessionId: 's1', recipientOverride: { kind: 'execution_run', runId: 'run_1' } });
        expect(details.props.browserContextState).toBe(browserRuntime?.composerContext.state);
        expect(details.props).not.toHaveProperty('presentation');
    });
    it.each([false, 0, '', null])('shows a defined latest result %j, and hides it only when absent', async (result) => {
        latestToolResult = result;
        await mount(); await loaded();
        expect(screen.findAllHostsByTestId('session-run-details-latest-tool-result')).toHaveLength(1);
        latestToolResult = undefined; await refresh();
        expect(screen.findAllHostsByTestId('session-run-details-latest-tool-result')).toHaveLength(0);
    });
    it('projects a recognizable result while keeping raw JSON subordinate', async () => {
        latestToolResult = { stdout: 'Four checks passed', exitCode: 0, marker: 'plugin-private-field' };
        await mount(); await loaded();
        expect(screen.findByTestId('session-run-details-latest-tool-result-raw')).toBeNull();
        await screen.pressByTestIdAsync('session-run-details-latest-tool-result-raw-toggle');
        expect(screen.getTextContent()).toContain('Four checks passed');
    });
    it('mounts the exact retained Run composer before any tool marker, with canonical queue/steer controls', async () => {
        runState = liveRun();
        await mount({ retryInputLocalId: 'first-input-1' }); await loaded();
        await vi.waitFor(() => expect(composer()).toHaveLength(1));
        expect(composer()[0]!.props).toMatchObject({ sessionId: 's1', serverId, canSendMessages: true,
            recipient: { kind: 'execution_run', runId: 'run_1' }, initialLocalId: 'first-input-1',
            executionRunRequestedAction: { v: 1, kind: 'enqueue' },
            extraActionChips: expect.arrayContaining([expect.objectContaining({ key: 'execution-run-requested-action', controlId: 'delivery' })]),
        });
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_SEND)).toEqual([]);
        await vi.waitFor(() => expect(httpReads.some(request => request.path === '/v2/sessions/s1/execution-runs/run_1/pending')).toBe(true));
    });
    it('shows a canonical waiting state before a Run has a transcript marker or queued rows', async () => {
        // Current public Run state always names its transcript IDs, even before their rows arrive.
        runState = createRun();
        await mount(); await loaded();
        expect(screen.findByTestId('session-run-details-pre-marker-state')).not.toBeNull();
        expect(screen.getTextContent()).toContain('status.awaitingUpdates');
        expect(composer()).toHaveLength(0);
        await act(async () => publishMarker());
        expect(screen.findByTestId('session-run-details-pre-marker-state')).toBeNull();
    });
    it('renders committed direct-start sidechain rows and the exact Run pending queue with one mounted composer', async () => {
        runState = liveRun();
        const child: NormalizedMessage = { id: 'sc-agent', localId: null, createdAt: 2, seq: 2, role: 'agent',
            isSidechain: true, sidechainId: 'toolu_1', content: [{ type: 'text', text: 'Working on it', uuid: 'sc-text', parentUUID: null }] };
        getStorage().getState().applyMessages('s1', [child]);
        getStorage().getState().applyMessagesLoaded('s1');
        const pending = createPendingMessageFixture({ id: 'queued-1', localId: 'queued-1',
            recipient: { kind: 'execution_run', runId: 'run_1' }, text: 'Continue this run' });
        pendingRows.push({ localId: pending.localId!, recipient: { kind: 'execution_run', runId: 'run_1' },
            messageRole: 'user', content: SessionStoredMessageContentSchema.parse({ t: 'plain', v: {
                role: 'user', content: { type: 'text', text: pending.text }, meta: {},
            } }), status: 'queued', position: 0, createdAt: 1, updatedAt: 1 });
        getStorage().getState().applyPendingSnapshot('s1', { messages: [pending], discarded: [] });
        await mount(); await loaded();
        await vi.waitFor(() => expect(screen.findByType(ChainTranscriptList).props.pendingMessages).toEqual(
            expect.arrayContaining([expect.objectContaining({ localId: 'queued-1', text: 'Continue this run' })]),
        ));
        const list = screen.findByType(ChainTranscriptList);
        expect(list.props).toMatchObject({ sessionId: 's1', serverId, pendingRecipient: { kind: 'execution_run', runId: 'run_1' } });
        expect(list.props.messages).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Working on it' })]));
        expect(composer()).toHaveLength(1);
        const input = composer()[0];
        await screen.update(<SessionExecutionRunDetailsView sessionId="s1" serverId={serverId} runId="run_1" presentation="panel" />);
        expect(composer()).toHaveLength(1); expect(composer()[0]).toBe(input);
    });
    it.each([
        ['unproven long-lived', { runClass: 'long_lived', retentionPolicy: 'resumable' }],
        ['bounded in-flight', { turnInFlight: true }],
        ['finished', { status: 'succeeded', turnInFlight: false }],
    ] satisfies ReadonlyArray<readonly [string, Partial<ExecutionRunPublicState>]>)
    ('keeps %s history read-only without a daemon-proven live retained interaction', async (_name, patch) => {
        runState = createRun(patch); publishMarker();
        await mount(); await loaded();
        expect(composer()).toHaveLength(0);
        expect(screen.findByTestId('session-run-details-send-input')).toBeNull();
    });
    it('does not expose input from an ambient same-ID Session in another Home', async () => {
        runState = liveRun();
        httpSessionAvailable = false;
        getStorage().setState(state => ({ sessions: { s1: { ...state.sessions.s1!, serverId: 'another-home' } } }));
        await mount();
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-load-error')).not.toBeNull());
        expect(composer()).toHaveLength(0);
        expect(screen.findByTestId('session-run-details-send-input')).toBeNull();
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toEqual([]);
    });
    it('keeps a body-only host from mounting a second composer or a redundant info card', async () => {
        runState = liveRun(); publishMarker();
        await mount({ showSendComposer: false, showInfoCard: false });
        await vi.waitFor(() => expect(screen.findAllByType(SessionMessageDetailsView)).toHaveLength(1));
        expect(composer()).toHaveLength(0); expect(screen.findAllByType(SessionExecutionRunInfoCard)).toHaveLength(0);
    });
    it('applies only exact Run activity and preserves the loaded composer through live refresh and completion', async () => {
        runState = liveRun(); await mount(); await loaded();
        const mountedComposer = composer()[0]!;
        const before = calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET).length;
        await act(async () => {
            notifyExecutionRunActivity({ sessionId: 'other-session', serverId }, { runId: 'run_1' });
            notifyExecutionRunActivity({ sessionId: 's1', serverId }, { runId: 'other-run' });
        });
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toHaveLength(before);
        runState = liveRun({ inputTurns: { occurrenceId: 'occurrence-1', current: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' } } });
        await refresh(); expect(composer()[0]).toBe(mountedComposer);
        runState = liveRun({ status: 'succeeded' }); await refresh();
        expect(screen.findByTestId('session-run-details-loading')).toBeNull(); expect(composer()).toHaveLength(0);
    });
    it('ignores a Run response that resolves after a newer exact-address response', async () => {
        await mount(); await loaded();
        let resolveOlder!: (value: unknown) => void;
        const old = new Promise<unknown>(resolve => { resolveOlder = resolve; });
        getReply = () => old;
        await act(async () => notifyExecutionRunActivity({ sessionId: 's1', serverId }, { runId: 'run_1' }));
        runState = createRun({ status: 'succeeded' }); getReply = async () => wireResult(); await refresh();
        await act(async () => resolveOlder({ run: createRun({ status: 'running' }) }));
        expect(info().run.status).toBe('succeeded');
    });
    it('cancels only the witnessed current turn through the rendered Run menu, not the whole Run', async () => {
        runState = liveRun({ inputTurns: { occurrenceId: 'occurrence-1', current: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' } } });
        await mount(); await loaded(); await menu();
        expect(screen.findByTestId('session-run-details-resume')).toBeNull();
        await screen.pressByTestIdAsync('session-run-details-cancel-turn');
        await vi.waitFor(() => expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1)).toHaveLength(1));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1)[0]![1]).toEqual({ runId: 'run_1', occurrenceId: 'occurrence-1', turnId: 'turn-1' });
        expect(boundary.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1)).toEqual([
            { serverUrl: home.homes.home!.serverUrl, targetId: 's1', method: SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1,
                payload: { runId: 'run_1', occurrenceId: 'occurrence-1', turnId: 'turn-1' } },
        ]);
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([]);
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE)).toEqual([]);
    });
    it('does not expose turn cancellation without the exact current occurrence and turn witness', async () => {
        runState = liveRun(); await mount(); await loaded(); await menu();
        expect(screen.findByTestId('session-run-details-cancel-turn')).toBeNull();
        expect(screen.findByTestId('session-run-details-stop')).not.toBeNull();
    });
    it('disables only the pending turn interaction while preserving the whole-Run stop affordance', async () => {
        runState = liveRun({ inputTurns: { occurrenceId: 'occurrence-1', current: { turnId: 'turn-1', inputIds: ['input-1'], state: 'active' } } });
        let settle!: (value: unknown) => void;
        cancelReply = () => new Promise(resolve => { settle = resolve; });
        await mount(); await loaded(); await menu(); screen.pressByTestId('session-run-details-cancel-turn');
        await vi.waitFor(() => expect(info().cancelResponseAction?.pending).toBe(true));
        expect(info().stopAction?.stopping).toBe(false);
        await act(async () => settle({ ok: true, status: 'requested', runId: 'run_1', occurrenceId: 'occurrence-1', turnId: 'turn-1' }));
        await vi.waitFor(() => expect(info().cancelResponseAction?.pending).toBe(false));
    });
    it('offers explicit recoverable Resume, with pending accessibility state and shared target sizes', async () => {
        runState = liveRun({ status: 'succeeded', interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } });
        let settle!: (value: unknown) => void;
        resumeReply = () => new Promise(resolve => { settle = resolve; });
        await mount(); await loaded();
        const target = screen.findByTestId('session-run-details-resume')!;
        const size = resolveMinimumInteractiveTargetSize(Platform.OS);
        expect(flattenTestStyle(target.props.style)).toMatchObject({ minWidth: size, minHeight: size });
        screen.pressByTestId('session-run-details-resume');
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-resume')?.props.accessibilityState).toMatchObject({ disabled: true, busy: true }));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE)[0]![1]).toEqual({ runId: 'run_1', resume: true });
        await act(async () => settle({ ok: true }));
    });
    it('refuses Resume through Action policy before issuing its transport', async () => {
        runState = liveRun({ status: 'succeeded', interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } });
        getStorage().setState(state => ({ settings: settingsParse({ ...state.settings, actionsSettingsV1: {
            v: 1, actions: { 'execution.run.ensure': { disabledSurfaces: ['ui'] } },
        } }) }));
        await mount(); await loaded();
        await screen.pressByTestIdAsync('session-run-details-resume');
        await vi.waitFor(() => expect(JSON.stringify(screen.tree.toJSON())).toContain('action_disabled'));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE)).toHaveLength(0);
    });
    it.each([
        ['execution.run.stop', 'session-run-details-stop', SESSION_RPC_METHODS.EXECUTION_RUN_STOP],
        ['execution.run.cancel_turn', 'session-run-details-cancel-turn', SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1],
    ] as const)('refuses %s through Action policy before issuing its transport', async (actionId, testId, method) => {
        runState = liveRun({ inputTurns: { occurrenceId: 'occurrence-1', current: {
            turnId: 'turn-1', inputIds: ['input-1'], state: 'active',
        } } });
        getStorage().setState(state => ({ settings: settingsParse({ ...state.settings, actionsSettingsV1: {
            v: 1, actions: { [actionId]: { disabledSurfaces: ['ui'] } },
        } }) }));
        await mount(); await loaded(); await menu();
        await screen.pressByTestIdAsync(testId);
        await vi.waitFor(() => expect(JSON.stringify(screen.tree.toJSON())).toContain('action_disabled'));
        expect(calls(method)).toHaveLength(0);
        expect(screen.findByTestId('session-run-details-stop-failed')).toBeNull();
    });
    it.each(['android', 'ios', 'web'] as const)('keeps the view-owned Resume target accessible on %s', async (platform) => {
        runState = liveRun({ status: 'succeeded', interaction: undefined, lifecycle: { v: 1, state: 'recoverable' } });
        const originalPlatform = Platform.OS;
        try {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
            await mount(); await loaded();
            const target = screen.findByTestId('session-run-details-resume');
            expect(target).not.toBeNull();
            const size = resolveMinimumInteractiveTargetSize(platform);
            expect(flattenTestStyle(target!.props.style)).toMatchObject({ minWidth: size, minHeight: size });
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
    it('stops on the exact Home and reloads terminal state when Stop races with completion', async () => {
        runState = liveRun();
        stopReply = async () => { runState = liveRun({ status: 'succeeded' }); return { ok: false, error: 'Already finished', errorCode: 'execution_run_not_allowed' }; };
        await mount(); await loaded(); await menu(); await screen.pressByTestIdAsync('session-run-details-stop');
        await vi.waitFor(() => expect(info().run.status).toBe('succeeded'));
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)[0]![1]).toEqual({ runId: 'run_1' });
        expect(boundary.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([
            { serverUrl: home.homes.home!.serverUrl, targetId: 's1', method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
                payload: { runId: 'run_1' } },
        ]);
        expect(info().stopAction).toBeNull();
        const accountReads = home.requests.filter(request => request.path !== '/v1/features');
        expect(accountReads.length).toBeGreaterThan(0);
        expect(accountReads.every(request => request.accountId === 'account-1')).toBe(true);
    });
    it('keeps whole-Run Stop busy until its actual transport request settles', async () => {
        runState = liveRun();
        let settle!: (value: unknown) => void;
        stopReply = () => new Promise(resolve => { settle = resolve; });
        await mount(); await loaded(); await menu(); screen.pressByTestId('session-run-details-stop');
        await vi.waitFor(() => expect(info().stopAction?.stopping).toBe(true));
        await act(async () => settle({ ok: true }));
        await vi.waitFor(() => expect(info().stopAction?.stopping).toBe(false));
    });
    it('falls back to retained transcript history, withholding mutable controls and daemon-marker queries without an exact Home', async () => {
        publishMarker('succeeded');
        getReply = async () => ({ ok: false, error: 'Run not found', errorCode: 'execution_run_not_found' });
        await mount({ serverId: undefined }); await loaded();
        expect(info().run).toMatchObject({ runId: 'run_1', status: 'succeeded' });
        expect(composer()).toHaveLength(0);
        expect(mutationMethods.flatMap(method => calls(method))).toEqual([]);
        expect(calls(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST)).toEqual([]);
    });
    it('loads main transcript history before failing closed on an absent Run, then offers a way out', async () => {
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: false }) } });
        getReply = async () => ({ ok: false, error: 'Run not found', errorCode: 'execution_run_not_found' });
        const close = vi.fn();
        await mount({ onRequestClose: close });
        await vi.waitFor(() => expect(httpReads.some(request => request.path.includes('/messages'))).toBe(true));
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-gone')).not.toBeNull());
        expect(screen.findByTestId('session-run-details-loading')).toBeNull();
        await screen.pressByTestIdAsync('session-run-details-gone-action'); expect(close).toHaveBeenCalledOnce();
        expect(mutationMethods.flatMap(method => calls(method))).toEqual([]);
    });
    it('names the opening wait and reading source, then recovers a failed load in place', async () => {
        let settle!: (value: unknown) => void;
        getReply = () => new Promise(resolve => { settle = resolve; });
        await mount({ openingTitle: 'Review the settings modal fix' });
        expect(screen.findByTestId('session-run-details-loading')).not.toBeNull();
        expect(screen.getTextContent()).toContain('surfaceState.opening(name=Review the settings modal fix)');
        await act(async () => settle({ ok: false, error: 'Home unreachable', errorCode: 'unavailable' }));
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-load-error-action')).not.toBeNull());
        getReply = async () => wireResult();
        await screen.pressByTestIdAsync('session-run-details-load-error-action'); await loaded();
        expect(screen.findByTestId('session-run-details-load-error-action')).toBeNull();
    });
    it('announces one semantic status change without repeating an unchanged refresh', async () => {
        const ref = React.createRef<SessionExecutionRunDetailsViewHandle>();
        await mount({ ref }); await loaded();
        runState = createRun({ status: 'succeeded', finishedAtMs: 2 });
        await act(async () => ref.current?.reload());
        const status = screen.findByTestId('session-run-details-accessibility-status');
        expect(status?.props.children.props.children).toContain('succeeded');
        const before = status?.props.children;
        await act(async () => ref.current?.reload());
        expect(screen.findByTestId('session-run-details-accessibility-status')?.props.children).toBe(before);
    });
    it('shows a finished review result without mounting a conversation composer', async () => {
        runState = createRun({ status: 'succeeded' });
        structuredMeta = { kind: 'review_findings.v2', payload: {
            runRef: { runId: 'run_1', callId: 'toolu_1', backendId: 'codex' },
            summary: 'Two findings, one high.', overviewMarkdown: 'The retry banner can double-charge.',
            findings: [
                { id: 'retry', title: 'Retry charges twice', severity: 'high', category: 'correctness', summary: 'Retry repeats the purchase.' },
                { id: 'pending', title: 'Pending state is unclear', severity: 'low', category: 'correctness', summary: 'The banner hides progress.' },
            ], generatedAtMs: 2,
        } };
        await mount(); await loaded();
        expect(screen.getTextContent()).toContain('The retry banner can double-charge.');
        expect(screen.getTextContent()).toContain('Retry charges twice');
        expect(screen.getTextContent()).toContain('Pending state is unclear');
        expect(screen.findByTestId('session-run-details-pre-marker-state')).toBeNull();
        expect(composer()).toHaveLength(0);
    });
    it('states the other live agents affected before an unconfirmed Run stop falls back to Session stop', async () => {
        runState = liveRun();
        // Execution Runs are locally projected from transcript/registry evidence,
        // not published in the provider workflow-only activity headline.
        const markers = Array.from({ length: 4 }, (_, index) => createToolCallMessageFixture({
            id: 'tool-msg-' + (index + 1), tool: {
                id: 'toolu_' + (index + 1), name: 'SubAgentRun', state: 'running',
                input: { ...runState, runId: 'run_' + (index + 1), label: 'Run ' + (index + 1) },
                createdAt: 1, startedAt: 1, completedAt: null, description: null,
            },
        }));
        getStorage().setState({ sessionMessages: { s1: createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: markers.map(marker => marker.id),
            messagesById: Object.fromEntries(markers.map(marker => [marker.id, marker])) }) } });
        stopReply = async () => ({ ok: false, error: 'Not confirmed', errorCode: 'rpc_timeout' });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await mount(); await loaded(); await menu(); await screen.pressByTestIdAsync('session-run-details-stop');
        await vi.waitFor(() => expect(screen.findByTestId('session-run-details-stop-failed')).not.toBeNull());
        expect(screen.getTextContent()).toContain('count=3');
        await screen.pressByTestIdAsync('session-run-details-stop-failed-secondary-action');
        expect(calls(RPC_METHODS.STOP_SESSION)).toHaveLength(1);
    });
});

describe('Neighboring user Run Stop admission', () => {
    beforeEach(() => {
        vi.mocked(Modal.alert).mockClear();
        vi.mocked(Modal.confirm).mockReset();
    });
    async function mountStopSurface(surface: 'runs' | 'machine' | 'subagent') {
        const original = boundary.call.getMockImplementation()!;
        boundary.call.mockImplementation(async (method, input) => method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST
            ? { runs: [{ ...runState,
                happyHomeDir: '/tmp/happier', happySessionId: 's1', pid: 123 }] }
            : original(method, input));
        getStorage().setState({ machineListStatusByServerId: { [serverId]: 'idle' } });
        if (surface === 'subagent') {
            const { SessionSubagentRow } = await import('@/components/sessions/agents/list/SessionSubagentRow');
            const row: React.ComponentProps<typeof SessionSubagentRow>['row'] = {
                subagent: { id: 'execution_run:run_1', kind: 'execution_run', status: 'running',
                        display: { title: 'Reviewer' }, transcript: { sidechainId: 'toolu_1' },
                        runRef: { runId: 'run_1', backendId: 'codex', intent: 'review' },
                        recipient: { kind: 'execution_run', runId: 'run_1' }, timestamps: {},
                        capabilities: { canOpen: true, canSend: true, canStop: true, canLaunchChild: false,
                            canDelete: false, canOpenAdvancedRun: true } },
                entry: { id: 'execution_run:run_1', kind: 'execution_run', status: 'running', title: 'Reviewer',
                    metaDetail: null, startedAtMs: null, endedAtMs: null, provenance: 'local', detailState: 'loaded',
                    parentId: null, runId: 'run_1', sidechainId: 'toolu_1', subagentId: 'execution_run:run_1', attentionKinds: [] },
            };
            screen = await renderScreen(<SessionSubagentRow sessionId="s1" serverId={serverId} row={row}
                onPress={() => {}} onOpenFull={null} onOpenAdvanced={null} />);
            return async () => { await act(async () => screen.findByTestId('session-subagent-actions:execution_run:run_1')!.props.onSelect('stop')); };
        }
        const { router } = await import('expo-router');
        // Runs now live on the Machine's Project work sub-page, not its Overview.
        router.setParams(surface === 'machine' ? { id: 'm1', page: 'work', serverId } : {});
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.homes.home!.serverUrl);
        const Screen = surface === 'runs' ? (await import('@/app/(app)/runs')).default
            : (await import('@/app/(app)/machines/[id]/[page]')).WorkspaceRouteBody;
        screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider><Screen /></AppPaneProvider></InjectedAuthProvider>);
        await vi.waitFor(() => expect(screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' }).length,
            screen.getTextContent()).toBeGreaterThan(0));
        return async () => { await act(async () => {
            await screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' })[0]!.props.onPress();
        }); };
    }

    it.each(['runs', 'machine', 'subagent'] as const)('refuses %s Stop through Action policy before transport or Session fallback', async surface => {
        const stop = await mountStopSurface(surface);
        const listsBeforeStop = calls(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST).length;
        await stop();
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([]);
        await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'action_disabled'));
        expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
        expect(calls(RPC_METHODS.KILL_SESSION)).toEqual([]);
        expect(vi.mocked(Modal.confirm)).not.toHaveBeenCalled();
        expect(calls(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST)).toHaveLength(listsBeforeStop);
    });

    it.each(['runs', 'machine', 'subagent'] as const)('sends admitted %s Stop to the exact Session and Home', async surface => {
        const stop = await mountStopSurface(surface);
        await stop();
        await vi.waitFor(() => expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(1));
        expect(boundary.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toEqual([
            { serverUrl: home.homes.home!.serverUrl, targetId: 's1', method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
                payload: { runId: 'run_1' } },
        ]);
        expect(calls(RPC_METHODS.STOP_SESSION)).toEqual([]);
        expect(calls(RPC_METHODS.KILL_SESSION)).toEqual([]);
    });

    it.each(['runs', 'machine'] as const)('preserves %s explicit Session fallback after an issued Run Stop fails', async surface => {
        stopReply = async () => ({ ok: false, error: 'Unsupported response from session RPC' });
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        const stop = await mountStopSurface(surface);
        await stop();
        expect(calls(SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toHaveLength(1);
        expect(vi.mocked(Modal.confirm)).toHaveBeenCalledOnce();
        // Both surfaces reach the real daemon Session-stop producer. A valid
        // stopped response must not fall through to a second runner stop.
        const method = RPC_METHODS.STOP_SESSION;
        await vi.waitFor(() => expect(calls(method)).toHaveLength(1));
        expect(boundary.requests.filter(request => request.method === method)).toEqual([
            { serverUrl: home.homes.home!.serverUrl, targetId: 'm1', method, payload: { sessionId: 's1' } },
        ]);
        expect(calls(RPC_METHODS.KILL_SESSION)).toEqual([]);
    });
});

describe('Teammate command Action admission', () => {
    beforeEach(() => vi.mocked(Modal.alert).mockClear());
    function sentInputs() {
        return home.requests.filter(request => request.method === 'POST'
            && (request.path === '/v2/sessions/s1/pending' || request.path === '/v2/sessions/s1/messages'));
    }
    it('delivers an Action-authored shutdown through the real scoped input sender', async () => {
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        const result = await execute('session.message.send', { sessionId: 's1', kind: 'sessionSubagentCommand',
            command: { kind: 'agent_team_member_delete', teamId: 'qa-team', memberId: 'alpha@qa-team', memberLabel: 'alpha' },
            localId: 'shutdown-action-1' }, { serverId, expectedAccountId: 'account-1', surface: 'ui',
            authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'shutdown-action-1' } });
        expect(sentInputs()).toHaveLength(1);
        expect(sentInputs()[0]!.body).toMatchObject({ localId: 'shutdown-action-1', requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Shutdown teammate alpha · qa-team' },
                meta: { displayText: 'Shutdown teammate alpha · qa-team', happier: { kind: 'subagent_command.v1',
                    payload: { kind: 'agent_team_member_delete', teamId: 'qa-team', memberId: 'alpha@qa-team', memberLabel: 'alpha' } } },
            } } });
    });
    async function mountCommandSurface(surface: 'member' | 'team') {
        const { SessionSubagentRow } = await import('@/components/sessions/agents/list/SessionSubagentRow');
        const { SessionSubagentGroup } = await import('@/components/sessions/agents/list/SessionSubagentGroup');
        const row: React.ComponentProps<typeof SessionSubagentRow>['row'] = {
            subagent: { id: 'agent_team_member:qa-team:alpha', kind: 'agent_team_member', status: 'running',
                display: { title: 'alpha', groupKey: 'qa-team', groupLabel: 'qa-team' },
                transcript: { toolMessageRouteId: 'message_2', sidechainId: 'toolu_2', toolId: 'toolu_2' },
                recipient: { kind: 'agent_team_member', teamId: 'qa-team', memberId: 'alpha@qa-team', memberLabel: 'alpha' },
                capabilities: { canOpen: true, canSend: true, canStop: false, canLaunchChild: false,
                    canDelete: true, canOpenAdvancedRun: false }, timestamps: {} },
            entry: { id: 'agent_team_member:qa-team:alpha', kind: 'agent_team_member', status: 'running', title: 'alpha',
                metaDetail: null, startedAtMs: null, endedAtMs: null, provenance: 'local', detailState: 'loaded',
                parentId: null, runId: null, sidechainId: 'toolu_2', subagentId: 'agent_team_member:qa-team:alpha', attentionKinds: [] },
        };
        screen = await renderScreen(surface === 'member'
            ? <SessionSubagentRow sessionId="s1" serverId={serverId} row={row} onPress={() => {}}
                onOpenFull={null} onOpenAdvanced={null} />
            : <SessionSubagentGroup sessionId="s1" serverId={serverId} label="qa-team" rows={[row]}
                activityPreviewById={new Map()} onOpenPreview={() => {}} onOpenFull={() => {}} onOpenAdvanced={() => {}} />);
        return async () => { await act(async () => {
            const menu = surface === 'member'
                ? screen.findByTestId('session-subagent-actions:agent_team_member:qa-team:alpha')!
                : screen.findByType(DropdownMenu);
            menu.props.onSelect(surface === 'member' ? 'delete' : 'delete-team');
        }); };
    }
    it.each(['member', 'team'] as const)('refuses %s shutdown through Action policy before input delivery', async surface => {
        const send = await mountCommandSurface(surface);
        await send();
        await vi.waitFor(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith('common.error', 'action_disabled'));
        expect(sentInputs()).toEqual([]);
        expect(boundary.messages).toEqual([]);
    });
    it.each(['member', 'team'] as const)('delivers admitted %s shutdown with its exact text and structured envelope', async surface => {
        const send = await mountCommandSurface(surface);
        await send();
        await vi.waitFor(() => expect(sentInputs(), JSON.stringify(vi.mocked(Modal.alert).mock.calls)).toHaveLength(1));
        const input = sentInputs()[0]!;
        expect(input.home).toBe('home');
        expect(input.accountId).toBe('account-1');
        expect(input.body).toMatchObject({ requestedAction: { v: 1, kind: 'send_now' }, content: { t: 'plain', v: {
            role: 'user', content: { type: 'text', text: surface === 'member' ? 'Shutdown teammate alpha · qa-team' : 'Delete team qa-team' },
            meta: { happier: { kind: 'subagent_command.v1', payload: surface === 'member'
                ? { kind: 'agent_team_member_delete', teamId: 'qa-team', memberId: 'alpha@qa-team', memberLabel: 'alpha' }
                : { kind: 'agent_team_delete', teamId: 'qa-team' } },
            },
        } } });
        expect(vi.mocked(Modal.alert)).not.toHaveBeenCalled();
    });
});
