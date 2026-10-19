import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from '../sessionRouteTestHelpers';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let sessionMock: any = { id: 'session-1', metadata: { agent: 'claude', permissionMode: 'default' } };
let machineCapabilitiesStateMock: any = { status: 'idle' };
let hydrateReady = true;
let hydratedServerId: string | undefined;
let enabledAgentIdsMock: string[] = ['claude', 'codex'];
let localSearchParamsMock: any = { id: 'session-1', intent: 'review' };
let sessionExecutionRunsSupportedMock = true;
let settingsMock: any = {
    executionRunsGuidanceEnabled: false,
    executionRunsGuidanceMaxChars: 4_000,
    executionRunsGuidanceEntries: [],
    acpCatalogSettingsV1: { v: 2, backends: [] },
};
let actionExecutorExecuteResultMock: any = {
    ok: true,
    result: { results: [{ ok: true }] },
};
let externalSessionRuntimeMock: any = {
    externalSessionLink: null,
    status: null,
    refreshNow: vi.fn(async () => null),
};
let sessionMachineReachabilityMock: any = {
    machineReachable: true,
    machineOnline: true,
    machineRpcTargetAvailable: true,
};
let resumeCapabilityOptionsMock: any = {};
const resumeSessionSpy = vi.fn(async () => ({ type: 'success', sessionId: 'session-1' }));
let activeServerSnapshotMock: any = { serverId: 'server-active', serverUrl: 'http://server-active.test' };
const useMachineCapabilitiesCacheSpy = vi.fn<(params: any) => { state: any; refresh: any }>();
const sessionServerIdStore = {
    value: null as string | null,
    listeners: new Set<() => void>(),
    getSnapshot() {
        return sessionServerIdStore.value;
    },
    set(next: string | null) {
        sessionServerIdStore.value = next;
        for (const listener of Array.from(sessionServerIdStore.listeners)) listener();
    },
    reset(next: string | null = null) {
        sessionServerIdStore.value = next;
        sessionServerIdStore.listeners.clear();
    },
    subscribe(listener: () => void) {
        sessionServerIdStore.listeners.add(listener);
        return () => {
            sessionServerIdStore.listeners.delete(listener);
        };
    },
};
function buildSessionServerLookupState() {
    const sessionServerId = sessionServerIdStore.getSnapshot();
    if (!sessionServerId) {
        return {
            concurrentSessionListCacheByServerId: {},
            sessions: {},
        };
    }

    return {
        concurrentSessionListCacheByServerId: {
            [sessionServerId]: {
                serverName: sessionServerId,
                sessions: {
                    'session-1': {
                        id: 'session-1',
                        serverId: sessionServerId,
                    },
                },
            },
        },
        sessions: {
            'session-1': {
                ...sessionMock,
                id: 'session-1',
                serverId: sessionServerId,
            },
        },
    };
}

function createSessionServerLookupStorageHook() {
    let cachedKey: string | null = null;
    let cachedSnapshot: any = null;
    const getSnapshot = () => {
        const key = sessionServerIdStore.getSnapshot();
        if (cachedSnapshot && key === cachedKey) {
            return cachedSnapshot;
        }
        cachedKey = key;
        cachedSnapshot = buildSessionServerLookupState() as any;
        return cachedSnapshot;
    };
    const subscribe = (listener: () => void) => sessionServerIdStore.subscribe(listener);

    const hook = ((selector?: (state: any) => unknown) => {
        const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
        return typeof selector === 'function' ? selector(snapshot) : snapshot;
    }) as any;

    hook.getState = getSnapshot;
    hook.getInitialState = getSnapshot;
    hook.subscribe = subscribe;
    hook.setState = () => undefined;
    hook.destroy = () => undefined;
    return hook;
}
let executionRunsBackendsMock: Record<string, { available?: boolean; intents?: string[] }> | null = {
    claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
    codex: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
    coderabbit: { available: true, intents: ['review'] },
};
let daemonMergedProjectionInputsMock: DaemonMergedProjectionInputs | null = null;

const startRunSpy = vi.fn(async (_sessionId: string, _request: any) => ({
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'call_1',
}));

const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const navigationCanGoBackSpy = vi.fn(() => true);
const stackScreenSpy = vi.fn((_props: any) => null);
const interactiveRunDraftViewSpy = vi.fn((_props: any) => null);
const credentialScopeTestState = vi.hoisted(() => ({
    bindingsByKey: new Map<string, ReadonlyMap<string, unknown>>(),
    resolutionsByKey: new Map<string, ReadonlyMap<string, unknown>>(),
}));
let NewRunScreen: typeof import('@/app/(app)/session/[id]/runs/new').default;

type RenderedNewRunScreen = Awaited<ReturnType<typeof renderScreen>>;

async function renderNewRunScreen(): Promise<RenderedNewRunScreen> {
    return renderScreen(React.createElement(NewRunScreen));
}

function translateText(key: string, params?: Record<string, unknown>) {
    if (key === 'executionRuns.newRun.headerTitle') return 'Start run';
    if (key === 'executionRuns.newRun.sections.intent') return 'Intent';
    if (key === 'executionRuns.newRun.sections.permissions') return 'Permissions';
    if (key === 'executionRuns.newRun.sections.backends') return 'Backends';
    if (key === 'executionRuns.newRun.sections.instructions') return 'Instructions';
    if (key === 'executionRuns.newRun.intents.review') return 'review';
    if (key === 'executionRuns.newRun.intents.plan') return 'plan';
    if (key === 'executionRuns.newRun.intents.delegate') return 'delegate';
    if (key === 'agentInput.permissionMode.default') return 'default';
    if (key === 'agentInput.permissionMode.readOnly') return 'read-only';
    if (key === 'agentInput.permissionMode.safeYolo') return 'safe-yolo';
    if (key === 'agentInput.permissionMode.yolo') return 'yolo';
    if (key === 'executionRuns.newRun.instructionsPlaceholder') return 'What should the sub-agent do?';
    if (key === 'executionRuns.newRun.actions.start') return 'Start';
    if (key === 'executionRuns.newRun.guidancePreview') return 'Guidance preview';
    if (key === 'session.actionsDraft.validation.requiredField') return `${String(params?.field ?? 'Field')} is required.`;
    if (key === 'common.unavailable') return 'Not available';
    if (key === 'errors.invalidFormat') return 'Invalid format';
    if (key === 'executionRuns.newRun.a11y.startRun') return 'Start run';
    if (key === 'executionRuns.newRun.a11y.cancel') return 'Cancel';
    if (key === 'executionRuns.newRun.a11y.selectIntent') return `Select intent ${String(params?.intent ?? '')}`;
    if (key === 'executionRuns.newRun.a11y.selectPermissionMode') return `Select permissionMode ${String(params?.mode ?? '')}`;
    if (key === 'executionRuns.newRun.a11y.toggleBackend') return `Toggle backend ${String(params?.backendId ?? '')}`;
    return key;
}

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            TextInput: 'TextInput',
            AppState: { currentState: 'active', addEventListener: vi.fn(), removeEventListener: vi.fn() },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#111',
                    text: '#eee',
                    textSecondary: '#aaa',
                    divider: '#333',
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            navigation: {
                canGoBack: navigationCanGoBackSpy,
            },
            router: {
                push: routerPushSpy,
                back: vi.fn(),
                replace: routerReplaceSpy,
                setParams: vi.fn(),
            },
        });
        return {
            ...routerMock.module,
            useLocalSearchParams: () => localSearchParamsMock,
            Stack: { Screen: (props: any) => stackScreenSpy(props) },
        };
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: translateText });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: vi.fn(),
            },
        }).module;
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            importOriginal,
            useSession: () => sessionMock,
            useSettings: () => settingsMock,
            storage: createSessionServerLookupStorageHook(),
        });
    },
});

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 999 },
    useLayoutMaxWidthStyle: () => ({ maxWidth: 999 }),
    useLayoutMaxWidth: () => 999,
}));
vi.mock('@/components/ui/feedback/ActivitySpinner', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/ui/feedback/ActivitySpinner')>(),
    ActivitySpinner: (props: Record<string, unknown>) => React.createElement('ActivitySpinner', props),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => hydrateReady
        ? { kind: 'available', sessionId, ...(hydratedServerId ? { serverId: hydratedServerId } : {}) }
        : { kind: 'loading', sessionId, reason: 'store-miss', ...(hydratedServerId ? { serverId: hydratedServerId } : {}) },
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const React = await import('react');
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useSessionServerId: () => React.useSyncExternalStore(
            sessionServerIdStore.subscribe,
            sessionServerIdStore.getSnapshot,
            sessionServerIdStore.getSnapshot,
        ),
    };
});

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => enabledAgentIdsMock,
}));
vi.mock('@/agents/catalog/enabled', () => ({
    getEnabledAgentIds: () => enabledAgentIdsMock,
}));
vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: () => executionRunsBackendsMock,
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: () => sessionExecutionRunsSupportedMock,
}));
vi.mock('@/components/sessions/model/useSessionExternalSessionRuntime', () => ({
    useSessionExternalSessionRuntime: () => externalSessionRuntimeMock,
}));
vi.mock('@/components/sessions/shell/sessionViewStableSession', () => ({
    useSessionViewShellSession: () => sessionMock,
}));
vi.mock('@/sync/store/settingsWriters', () => ({
    useAccountSettingsScope: () => ({
        serverId: sessionServerIdStore.getSnapshot() ?? 'server-active',
        accountId: 'account-1',
    }),
}));
vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeBindings: (serverIds: readonly (string | null | undefined)[]) => {
        const key = JSON.stringify(serverIds);
        const existing = credentialScopeTestState.bindingsByKey.get(key);
        if (existing) return existing;
        const bindings = new Map(serverIds.flatMap((serverId) => serverId ? [[serverId, {
            serverId,
            accountId: 'account-1',
            scope: { serverId, accountId: 'account-1' },
            isCurrent: () => true,
        }] as const] : []));
        credentialScopeTestState.bindingsByKey.set(key, bindings);
        return bindings;
    },
    useServerCredentialAccountScopeResolutions: (serverIds: readonly (string | null | undefined)[]) => {
        const key = JSON.stringify(serverIds);
        const existing = credentialScopeTestState.resolutionsByKey.get(key);
        if (existing) return existing;
        const resolutions = new Map(serverIds.flatMap((serverId) => serverId ? [[serverId, {
            kind: 'bound',
            scope: { serverId, accountId: 'account-1' },
        }] as const] : []));
        credentialScopeTestState.resolutionsByKey.set(key, resolutions);
        return resolutions;
    },
}));
vi.mock('@/sync/domains/state/accountSettingsPersistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/state/accountSettingsPersistence')>(),
    loadAccountSettings: () => ({ settings: settingsMock, version: 1 }),
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => sessionMachineReachabilityMock,
}));
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: resumeCapabilityOptionsMock }),
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        phase: daemonMergedProjectionInputsMock ? 'ready' : 'idle',
        inputs: daemonMergedProjectionInputsMock,
    }),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStart: (sessionId: string, request: any) => startRunSpy(sessionId, request),
    sessionExecutionRunList: vi.fn(),
    sessionExecutionRunGet: vi.fn(),
    sessionExecutionRunSend: vi.fn(),
    sessionExecutionRunStop: vi.fn(),
    sessionExecutionRunAction: vi.fn(),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({
        execute: async (actionId: string, request: any) => {
            const intent = actionId === 'review.start' ? 'review' : actionId === 'subagents.plan.start' ? 'plan' : 'delegate';
            const firstBackendTargetKey = typeof request?.backendTargetKeys?.[0] === 'string'
                ? String(request.backendTargetKeys[0])
                : undefined;
            const backendTarget = firstBackendTargetKey?.startsWith('agent:')
                ? { kind: 'builtInAgent', agentId: firstBackendTargetKey.slice('agent:'.length) }
                : firstBackendTargetKey?.startsWith('acpBackend:')
                    ? { kind: 'configuredAcpBackend', backendId: firstBackendTargetKey.slice('acpBackend:'.length) }
                    : undefined;
            const backendId = intent === 'review'
                ? request?.engineIds?.[0]
                : backendTarget?.kind === 'builtInAgent'
                    ? backendTarget.agentId
                    : backendTarget?.kind === 'configuredAcpBackend'
                        ? backendTarget.backendId
                        : undefined;
            await startRunSpy(request?.sessionId, {
                ...request,
                intent,
                backendId,
                ...(backendTarget ? { backendTarget } : {}),
            });
            return actionExecutorExecuteResultMock;
        },
    }),
}));
vi.mock('@/sync/ops/sessions', () => ({
    resumeSession: (...args: Parameters<typeof resumeSessionSpy>) => resumeSessionSpy(...args),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshotMock,
    subscribeActiveServer: () => () => {},
}));
vi.mock('@/components/sessions/runs/launcher/SessionInteractiveExecutionRunDraftView', () => ({
    SessionInteractiveExecutionRunDraftView: (props: any) => {
        interactiveRunDraftViewSpy(props);
        return React.createElement('SessionInteractiveExecutionRunDraftView', props);
    },
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    useMachineCapabilitiesCache: (params: any) => {
        useMachineCapabilitiesCacheSpy(params);
        return { state: machineCapabilitiesStateMock, refresh: vi.fn() };
    },
}));

describe('Session New Run Screen', () => {
    beforeAll(async () => {
        vi.resetModules();
        NewRunScreen = (await import('@/app/(app)/session/[id]/runs/new')).default;
    }, 120_000);

    afterAll(() => {
        vi.resetModules();
    });

    afterEach(() => {
        standardCleanup();
        startRunSpy.mockClear();
        routerPushSpy.mockClear();
        routerReplaceSpy.mockClear();
        navigationCanGoBackSpy.mockReturnValue(true);
        stackScreenSpy.mockClear();
        interactiveRunDraftViewSpy.mockClear();
        executionRunsBackendsMock = {
            claude: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            codex: { available: true, intents: ['review', 'plan', 'delegate', 'voice_agent'] },
            coderabbit: { available: true, intents: ['review'] },
        };
        daemonMergedProjectionInputsMock = null;
        enabledAgentIdsMock = ['claude', 'codex'];
        sessionMock = { id: 'session-1', metadata: { agent: 'claude', permissionMode: 'default' } };
        machineCapabilitiesStateMock = { status: 'idle' };
        hydrateReady = true;
        hydratedServerId = undefined;
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        settingsMock = {
            executionRunsGuidanceEnabled: false,
            executionRunsGuidanceMaxChars: 4_000,
            executionRunsGuidanceEntries: [],
            acpCatalogSettingsV1: { v: 2, backends: [] },
        };
        sessionExecutionRunsSupportedMock = true;
        sessionMachineReachabilityMock = {
            machineReachable: true,
            machineOnline: true,
            machineRpcTargetAvailable: true,
        };
        resumeCapabilityOptionsMock = {};
        resumeSessionSpy.mockClear();
        useMachineCapabilitiesCacheSpy.mockClear();
        sessionServerIdStore.reset('server-active');
        activeServerSnapshotMock = { serverId: 'server-active', serverUrl: 'http://server-active.test' };
        actionExecutorExecuteResultMock = {
            ok: true,
            result: { results: [{ ok: true }] },
        };
        externalSessionRuntimeMock = {
            externalSessionLink: null,
            status: null,
            refreshNow: vi.fn(async () => null),
        };
    });

    it('opens an empty Agent conversation when no bounded intent is present and creates nothing on mount', async () => {
        localSearchParamsMock = { id: 'session-1' };
        await renderNewRunScreen();

        expect(interactiveRunDraftViewSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
        expect(startRunSpy).not.toHaveBeenCalled();
    });

    it('keeps the hydrated Home and retry identity qualified when the first interactive send opens its Run', async () => {
        localSearchParamsMock = { id: 'session-1' };
        hydratedServerId = 'server-hydrated';
        await renderNewRunScreen();

        const props = interactiveRunDraftViewSpy.mock.calls.at(-1)?.[0];
        expect(props).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            serverId: 'server-hydrated',
        }));

        await act(async () => {
            props.onRunStarted('run/1', { retryInputLocalId: 'first-input-1' });
        });

        expect(routerReplaceSpy).toHaveBeenCalledWith(
            '/session/session-1/runs/run%2F1?serverId=server-hydrated&retryInputLocalId=first-input-1',
        );
    });

    it('consumes a qualified Discussion-selection navigation intent without routing selected text', async () => {
        const { publishInteractiveExecutionRunDraftNavigationIntent } = await import('@/components/sessions/runs/launcher/interactiveExecutionRunDraftNavigationIntent');
        const published = publishInteractiveExecutionRunDraftNavigationIntent({
            address: { serverId: 'server-a', sessionId: 'session-1' },
            source: {
                kind: 'discussion',
                serverId: 'server-a',
                discussionId: 'discussion-a',
                messageIds: ['message-a'],
                draftCorrelationId: 'correlation-a',
            },
            initialText: 'private selected text',
        });
        localSearchParamsMock = { id: 'session-1', serverId: 'server-a', draftCorrelationId: published.correlationId };
        hydrateReady = false;

        const screen = await renderNewRunScreen();

        expect(interactiveRunDraftViewSpy).not.toHaveBeenCalled();
        hydrateReady = true;
        await act(async () => {
            screen.tree.update(React.createElement(NewRunScreen));
        });

        expect(interactiveRunDraftViewSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            serverId: 'server-a',
            initialText: 'private selected text',
            launchOrigin: {
                kind: 'discussion',
                serverId: 'server-a',
                discussionId: 'discussion-a',
                messageIds: ['message-a'],
                draftCorrelationId: 'correlation-a',
            },
        }));
        expect(published.href).not.toContain('private');
    });

    it('opens an ordinary empty interactive draft when a deep link has no process-local intent', async () => {
        localSearchParamsMock = { id: 'session-1', serverId: 'server-a', draftCorrelationId: 'missing-correlation' };

        await renderNewRunScreen();

        const props = interactiveRunDraftViewSpy.mock.calls[0]?.[0];
        expect(props).toEqual(expect.objectContaining({ sessionId: 'session-1', serverId: 'server-a' }));
        expect(props.initialText).toBeUndefined();
        expect(props.launchOrigin).toBeUndefined();
    });

    it('renders a loading state while session hydration is pending', async () => {
        hydrateReady = false;
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        const screen = await renderNewRunScreen();
        expect(screen.findAllByType('ActivitySpinner').length).toBeGreaterThan(0);
        hydrateReady = true;
    });

    it('does not crash when hydration flips from pending to ready', async () => {
        hydrateReady = false;
        localSearchParamsMock = { id: 'session-1', intent: 'review' };
        const screen = await renderNewRunScreen();

        hydrateReady = true;
        await act(async () => {
            screen.tree.update(React.createElement(NewRunScreen));
        });
    });

    it('fails closed when the route intent is valid but unsupported by the launcher', async () => {
        localSearchParamsMock = { id: 'session-1', intent: 'voice_agent' };

        const screen = await renderNewRunScreen();

        expect(interactiveRunDraftViewSpy).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('Invalid format');
    });

    it('opens the composer-first start for a bounded intent, with that intent (no launcher form)', async () => {
        localSearchParamsMock = { id: 'session-1', intent: 'plan' };
        await renderNewRunScreen();

        expect(interactiveRunDraftViewSpy).toHaveBeenLastCalledWith(expect.objectContaining({
            sessionId: 'session-1',
            intent: 'plan',
        }));
        expect(stackScreenSpy.mock.calls.at(-1)?.[0]?.options?.title).toBe('plan');
        expect(startRunSpy).not.toHaveBeenCalled();
    });
});
