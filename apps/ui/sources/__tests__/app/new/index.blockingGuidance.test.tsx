import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
    persistedDraft: null as Record<string, unknown> | null,
    tempData: null as Record<string, unknown> | null,
    serverId: 's1',
    resolvedTargetServerId: undefined as string | null | undefined,
    localSearchParams: {
        dataId: 'draft-data-id',
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
    } as {
        dataId?: string;
        spawnServerId?: string;
        draftId?: string;
        draftServerId?: string;
        draftAccountId?: string;
    },
    serverListeners: new Set<() => void>(),
    guidanceModelListeners: new Set<() => void>(),
    guidanceKind: 'connect_machine' as 'connect_machine' | 'select_session',
    shouldBlockNewSession: true,
    guidanceHookCalls: 0,
    newSessionBlockHookCalls: 0,
    wizardRenders: 0,
    portalScopeRenders: 0,
    draftScopeEnabled: false,
    requestedDraftScope: null as { serverId: string; accountId: string } | null,
    draftReadScopes: [] as Array<{ serverId: string; accountId: string }>,
    draftDeleteCalls: [] as Array<Readonly<{
        scope: { serverId: string; accountId: string };
        address: { kind: 'newSession'; draftId: string };
    }>>,
    routerPush: vi.fn(),
    routerReplace: vi.fn(),
    routerSetParams: vi.fn(),
}));

function setMockServerId(serverId: string): void {
    mockState.serverId = serverId;
    for (const listener of mockState.serverListeners) {
        listener();
    }
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                        }
    );
});

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));
vi.mock('@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel', () => ({
    useSessionGettingStartedGuidanceBaseModel: () => {
        mockState.guidanceHookCalls += 1;

        const serverId = React.useSyncExternalStore(
            (listener) => {
                mockState.guidanceModelListeners.add(listener);
                return () => {
                    mockState.guidanceModelListeners.delete(listener);
                };
            },
            () => mockState.serverId,
            () => mockState.serverId,
        );

        return {
            kind: mockState.guidanceKind,
            targetLabel: 'Test server',
            serverId,
            serverName: 'Test',
            serverUrl: 'https://api.happier.dev',
            showServerSetup: false,
        };
    },
}));
vi.mock('@/components/sessions/guidance/useShouldBlockNewSessionWithGettingStartedGuidance', () => ({
    useShouldBlockNewSessionWithGettingStartedGuidance: () => {
        mockState.newSessionBlockHookCalls += 1;
        return mockState.shouldBlockNewSession;
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: mockState.serverId,
        serverUrl: 'https://api.happier.dev',
        generation: 1,
    }),
    subscribeActiveServer: (listener: (snapshot: { serverId: string; serverUrl: string; generation: number }) => void) => {
        mockState.serverListeners.add(() => {
            listener({
                serverId: mockState.serverId,
                serverUrl: 'https://api.happier.dev',
                generation: 1,
            });
        });
        return () => {
            mockState.serverListeners.delete(listener as unknown as () => void);
        };
    },
}));

vi.mock('@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState', () => ({
    useNewSessionServerTargetState: ({ request }: { request: { spawnServerIdParam?: string | null } }) => ({
        targetServerId: typeof request?.spawnServerIdParam === 'string'
            ? request.spawnServerIdParam
            : mockState.resolvedTargetServerId === undefined
                ? mockState.serverId
                : mockState.resolvedTargetServerId,
    }),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        params: mockState.localSearchParams,
        router: {
            push: (...args: unknown[]) => mockState.routerPush(...args),
            replace: (...args: unknown[]) => mockState.routerReplace(...args),
            setParams: (...args: unknown[]) => mockState.routerSetParams(...args),
        },
    });
    return expoRouterMock.module;
});

vi.mock('@/sync/domains/scope/useServerCredentialAccountScopes', () => ({
    useServerCredentialAccountScopeResolution: (serverId: string | null | undefined) => (
        serverId && mockState.requestedDraftScope?.serverId === serverId
            ? { kind: 'bound', scope: mockState.requestedDraftScope }
            : { kind: 'unknown_home' }
    ),
    useServerCredentialAccountScopeBindings: (serverIds: readonly string[]) => new Map(
        serverIds.flatMap((serverId) => (
            mockState.requestedDraftScope?.serverId === serverId
                ? [[serverId, {
                    scope: mockState.requestedDraftScope,
                    isCurrent: () => true,
                    serverId,
                    accountId: mockState.requestedDraftScope.accountId,
                    revision: 1,
                }] as const]
                : []
        )),
    ),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>()),
    getServerProfileById: (serverId: string) => ({ id: serverId, serverUrl: `https://${serverId}.test` }),
}));

vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/http/client')>()),
    createServerFetchAtEndpoint: () => vi.fn(),
}));

vi.mock('@/sync/ops/sessionDrafts/runWithSessionDraftRepositoryScopedRuntime', () => ({
    runWithSessionDraftRepositoryScopedRuntime: async ({ binding, operation }: {
        binding: { scope: { serverId: string; accountId: string }; isCurrent: () => boolean };
        operation: (input: unknown) => Promise<unknown>;
    }) => operation({ scope: binding.scope, runtime: {}, isCurrent: binding.isCurrent }),
}));

vi.mock('@/sync/ops/sessionDrafts/sessionDraftRepository', () => ({
    getSessionDraftSnapshot: (scope: { serverId: string; accountId: string }) => {
        mockState.draftReadScopes.push(scope);
        return mockState.persistedDraft;
    },
    subscribeSessionDraft: () => () => {},
    deleteSessionDraft: vi.fn(async (input: Readonly<{
        scope: { serverId: string; accountId: string };
        address: { kind: 'newSession'; draftId: string };
    }>) => {
        mockState.draftDeleteCalls.push(input);
        return true;
    }),
    deleteSessionDraftWithScopedRuntime: vi.fn(async (input: Readonly<{
        scope: { serverId: string; accountId: string };
        address: { kind: 'newSession'; draftId: string };
    }>) => {
        mockState.draftDeleteCalls.push({ scope: input.scope, address: input.address });
        return true;
    }),
}));

vi.mock('@/sync/domains/actionOperations/useActionOperations', () => ({
    useAllActionOperations: () => [],
    readAllActionOperations: () => [],
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: async () => true } }).module;
});

vi.mock('@/components/sessions/new/modules/newSessionDraftLaunchCustody', () => ({
    isNewSessionDraftLaunchInCustody: () => false,
}));

vi.mock('@/components/sessions/drafts/SessionDraftConflictResolution', () => ({
    SessionDraftConflictResolution: () => React.createElement('ConflictNotice', { testID: 'draft-conflict-notice' }),
    useSessionDraftConflictComposerBanner: () => ({ collapsed: false }),
}));

vi.mock('@/components/sessions/composerBanners/ComposerBannerCollapseProvider', () => ({
    ComposerBannerCollapseProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/sessions/drafts/NewSessionDraftComposerActions', () => ({
    NewSessionDraftComposerActions: (props: Readonly<{
        deleteDisabled: boolean;
        onStartAnother: () => void;
        onDelete: () => Promise<void>;
    }>) => React.createElement(
        'DraftComposerActions',
        props,
        React.createElement('Pressable', {
            testID: 'new-session-draft-start-another',
            onPress: props.onStartAnother,
        }),
        React.createElement('Pressable', {
            testID: 'new-session-draft-delete',
            disabled: props.deleteDisabled,
            onPress: props.onDelete,
        }),
    ),
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: (props: Record<string, unknown>) => React.createElement('Icon', props),
    ICON_SIZE: { xs: 14, sm: 16, md: 18, lg: 20, xl: 24 },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => mockState.tempData,
}));

vi.mock('@/components/sessions/new/hooks/useNewSessionScreenModel', () => ({
    useNewSessionScreenModel: (input: Readonly<{
        composerTopContent?: React.ReactNode;
        draftId: string;
        statusTrailingActions?: React.ReactNode;
    }>) => ({
        variant: 'wizard',
        popoverBoundaryRef: { current: null },
        wizardProps: {
            layout: null,
            profiles: null,
            agent: null,
            machine: null,
            footer: {
                composerTopContent: input.composerTopContent,
                statusTrailingActions: input.statusTrailingActions,
            },
        },
    }),
}));

vi.mock('@/components/sessions/new/components/NewSessionSimplePanel', () => ({
    NewSessionSimplePanel: 'NewSessionSimplePanel',
}));
// The embedded (Home) presentation's composer card; the /new route never renders it.
vi.mock('@/components/sessions/new/components/NewSessionComposerCard', () => ({
    NewSessionComposerCard: 'NewSessionComposerCard',
}));

vi.mock('@/components/sessions/new/components/NewSessionWizard', () => ({
    NewSessionWizard: (props: Record<string, unknown>) => {
        mockState.wizardRenders += 1;
        const footer = props.footer as Readonly<{
            composerTopContent?: React.ReactNode;
            statusTrailingActions?: React.ReactNode;
        }> | null;
        return React.createElement(
            'NewSessionWizard',
            props,
            footer?.composerTopContent,
            footer?.statusTrailingActions,
        );
    },
}));

vi.mock('@/components/sessions/new/navigation/newSessionContainedModalScreen', () => ({
    NewSessionScreenPortalScope: ({ children }: { children: React.ReactNode }) => {
        mockState.portalScopeRenders += 1;
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('@/components/ui/popover', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/popover')>();
    return {
        ...actual,
        PopoverBoundaryProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
        PopoverPortalTargetProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
        PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
    };
});

await loadSyncSingletonForTests();
const Screen = (await import('@/app/(app)/new')).default;
const { storage } = await import('@/sync/domains/state/storage');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');

beforeEach(() => {
    setMockServerId('s1');
    storage.getState().activateProfileScope({ serverId: 's1', accountId: 'account-1' });
    publishAppliedActiveServerSnapshot({ serverId: 's1', serverUrl: 'https://api.happier.dev', generation: 1 });
    storage.setState({ isSessionDraftsReady: true });
});

afterEach(async () => {
    await standardCleanup();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.getState().clearProfileScope();
    mockState.persistedDraft = null;
    mockState.tempData = null;
    mockState.serverListeners.clear();
    mockState.guidanceModelListeners.clear();
    mockState.serverId = 's1';
    mockState.guidanceKind = 'connect_machine';
    mockState.shouldBlockNewSession = true;
    mockState.resolvedTargetServerId = undefined;
    for (const key of Object.keys(mockState.localSearchParams)) {
        delete mockState.localSearchParams[key as keyof typeof mockState.localSearchParams];
    }
    Object.assign(mockState.localSearchParams, {
        dataId: 'draft-data-id',
        draftId: '8e0a5dd1-b1df-43dd-b51e-b7787b30362e',
    });
    mockState.guidanceHookCalls = 0;
    mockState.newSessionBlockHookCalls = 0;
    mockState.wizardRenders = 0;
    mockState.portalScopeRenders = 0;
    mockState.draftScopeEnabled = false;
    mockState.requestedDraftScope = null;
    mockState.draftReadScopes = [];
    mockState.draftDeleteCalls = [];
    mockState.routerPush.mockReset();
    mockState.routerReplace.mockReset();
    mockState.routerSetParams.mockReset();
});

describe('/new (blocking guidance)', () => {
    it('hard-stops with connect-machine guidance when no machines exist', async () => {
        setMockServerId('s1');
        mockState.persistedDraft = null;
        mockState.tempData = null;
        mockState.shouldBlockNewSession = true;

        const screen = await renderScreen(React.createElement(Screen));

        expect(() => screen.findByType('SessionGettingStartedGuidance')).not.toThrow();
        expect(() => screen.findByType('NewSessionWizard')).toThrow();
        expect(mockState.portalScopeRenders).toBe(0);
    });

    it('keeps the new-session panel out of full getting-started model invalidations', async () => {
        setMockServerId('s1');
        mockState.persistedDraft = null;
        mockState.tempData = null;
        mockState.guidanceKind = 'select_session';
        mockState.shouldBlockNewSession = false;

        await renderScreen(React.createElement(Screen));

        expect(mockState.wizardRenders).toBe(1);
        expect(mockState.portalScopeRenders).toBe(1);
        expect(mockState.guidanceHookCalls).toBe(0);
        expect(mockState.newSessionBlockHookCalls).toBe(1);

        for (const listener of mockState.guidanceModelListeners) {
            listener();
        }

        expect(mockState.wizardRenders).toBe(1);
        expect(mockState.guidanceHookCalls).toBe(0);
    });

    it('keeps the wizard path when temp data seeds a worktree draft intent', async () => {
        setMockServerId('s1');
        mockState.persistedDraft = null;
        mockState.tempData = {
            workspaceId: 'workspace-1',
            workspaceLocationId: 'location-1',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature-x',
                baseRef: 'main',
            },
        };

        const screen = await renderScreen(React.createElement(Screen));

        expect(() => screen.findByType('NewSessionWizard')).not.toThrow();
        expect(() => screen.findByType('SessionGettingStartedGuidance')).toThrow();
    });

    it('does not subscribe to getting-started guidance when temp data seeds a machine intent', async () => {
        setMockServerId('s1');
        mockState.persistedDraft = null;
        mockState.tempData = {
            machineId: 'machine-1',
        };

        await renderScreen(React.createElement(Screen));

        expect(mockState.guidanceHookCalls).toBe(0);
        expect(mockState.wizardRenders).toBe(1);

        setMockServerId('s2');

        expect(mockState.guidanceHookCalls).toBe(0);
        expect(mockState.wizardRenders).toBe(1);
    });

    it('opens a materialized draft without duplicate context copy and places conflict plus actions beside the composer', async () => {
        mockState.draftScopeEnabled = true;
        mockState.shouldBlockNewSession = true;
        mockState.persistedDraft = {
            address: { kind: 'newSession', draftId: mockState.localSearchParams.draftId },
            document: {
                v: 1,
                composer: {
                    text: { mutationId: 'text-1', value: 'Resume the migration\nwith tests' },
                    mentions: { mutationId: 'mentions-1', value: [] },
                    attachments: { mutationId: 'attachments-1', value: [] },
                },
                target: { kind: 'newSession', authoring: {} },
                extensions: {},
            },
            status: 'conflict',
            conflict: { fields: [] },
            createdAt: 1,
            updatedAt: 2,
            materialized: true,
            deleteWhenEmpty: false,
            localSupplement: {},
        };

        const screen = await renderScreen(React.createElement(Screen));

        expect(() => screen.findByProps({ testID: 'session-draft-context' })).toThrow();
        expect(screen.findByProps({ testID: 'draft-conflict-notice' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'new-session-draft-start-another' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'new-session-draft-delete' }).props.disabled).toBe(false);

        await pressTestInstanceAsync(screen.findByProps({ testID: 'new-session-draft-start-another' }));
        expect(mockState.routerPush).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
                draftOrigin: 'ordinary',
            },
        });
    });

    it('reopens and deletes a waiting draft through its route-qualified inactive Home Account', async () => {
        const draftId = '8e0a5dd1-b1df-43dd-b51e-b7787b30362e';
        mockState.draftScopeEnabled = true;
        mockState.shouldBlockNewSession = false;
        setMockServerId('home-a');
        storage.getState().activateProfileScope({ serverId: 'home-a', accountId: 'account-1' });
        publishAppliedActiveServerSnapshot({ serverId: 'home-a', serverUrl: 'https://api.happier.dev', generation: 1 });
        mockState.requestedDraftScope = { serverId: 'home-b', accountId: 'account-b' };
        for (const key of Object.keys(mockState.localSearchParams)) {
            delete mockState.localSearchParams[key as keyof typeof mockState.localSearchParams];
        }
        Object.assign(mockState.localSearchParams, {
            draftId,
            spawnServerId: 'home-b',
            draftServerId: 'home-b',
            draftAccountId: 'account-b',
        });
        mockState.persistedDraft = {
            address: { kind: 'newSession', draftId },
            document: {
                v: 2,
                composer: {
                    text: { mutationId: 'text-1', value: 'Waiting for computer' },
                    mentions: { mutationId: 'mentions-1', value: [] },
                    attachments: { mutationId: 'attachments-1', value: [] },
                },
                target: { kind: 'newSession', authoring: {} },
                extensions: {},
            },
            status: 'clean',
            conflict: null,
            createdAt: 1,
            updatedAt: 2,
            materialized: true,
            deleteWhenEmpty: false,
            localSupplement: {},
        };

        const Screen = (await import('@/app/(app)/new')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(mockState.draftReadScopes).toContainEqual({ serverId: 'home-b', accountId: 'account-b' });
        expect(mockState.draftReadScopes).not.toContainEqual({ serverId: 'home-a', accountId: 'account-1' });

        await pressTestInstanceAsync(screen.findByProps({ testID: 'new-session-draft-delete' }));

        expect(mockState.draftDeleteCalls).toEqual([{
            scope: { serverId: 'home-b', accountId: 'account-b' },
            address: { kind: 'newSession', draftId },
        }]);
    });
});
