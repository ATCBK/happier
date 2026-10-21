// @vitest-environment jsdom
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import {
    createSessionFixture,
    createMachineFixture,
    pressTestInstanceAsync,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { t } from '@/text';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { InboxSessionAttentionGroupCard } from './InboxSessionAttentionGroupCard';

const NOW_MS = 1_000_000;
const SESSION_ID = 'global-voice-after-end';
const REQUEST_ID = 'permission-after-end';
const permissionRpc = vi.hoisted(() => vi.fn(async (_request: Readonly<{
    serverUrl: string | undefined; method: string; params: unknown;
}>) => undefined));
const routerPush = vi.hoisted(() => vi.fn());
const initialState = storage.getState();
let home: Awaited<ReturnType<typeof serveSessionActionHome>>;
let serverIdA: string;
let serverIdB: string;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Text: 'Text',
        Pressable: 'Pressable',
        TouchableOpacity: 'TouchableOpacity',
        ActivityIndicator: 'ActivityIndicator',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            push: routerPush,
        },
    }).module;
});
// Account, crypto and Home qualification run in the real RPC wrapper. Only
// Socket.IO's external delivery and acknowledgement are synthetic.
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
            || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Expected Socket RPC request');
        if (!payload.method.endsWith(`:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`)) throw new Error('Unexpected request in Inbox fixture');
        await permissionRpc({ serverUrl, method: payload.method, params: payload.params });
        return { ok: true, result: undefined };
    });
});

function createPendingPostEndSession(): Session {
    return createSessionFixture({
        id: SESSION_ID,
        encryptionMode: 'plain',
        serverId: serverIdA,
        seq: 4,
        lastViewedSessionSeq: 4,
        active: true,
        activeAt: NOW_MS - 100,
        updatedAt: NOW_MS - 10,
        presence: 'online',
        pendingPermissionRequestCount: 1,
        pendingRequestObservedAt: NOW_MS - 10,
        metadata: {
            name: 'Global Voice session',
            path: '/Users/tester/project',
            host: 'tester.local',
            homeDir: '/Users/tester',
            flavor: 'codex',
            systemSessionV1: {
                v: 1,
                key: 'voice_conversation',
                hidden: true,
            },
        },
        agentState: {
            controlledByUser: null,
            requests: {
                [REQUEST_ID]: {
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'git status' },
                    createdAt: NOW_MS - 10,
                },
            },
            completedRequests: {},
        },
    });
}

function createActivitySource(session: Session): ActivityAttentionSource {
    return {
        isDataReady: true,
        sessionsById: { [session.id]: session },
        sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {},
        sessionListIndexByServerId: {
            // Hidden system sessions are intentionally absent from the ordinary list.
            [serverIdA]: [],
        },
        concurrentSessionListCacheByServerId: {},
        serverProfilesById: {
            [serverIdA]: {
                id: serverIdA,
                name: 'Server A',
                serverUrl: 'https://a.example.test',
                createdAt: 1,
                updatedAt: 1,
                lastUsedAt: 1,
                source: 'manual',
            },
        },
        activeServer: {
            serverId: serverIdA,
            serverUrl: 'https://a.example.test',
            generation: 1,
        },
    };
}

describe('global Voice post-End permission custody', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        const sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
        home = await serveSessionActionHome({
            homes: [
                { key: 'b', serverUrl: 'https://b.example.test', accountId: 'account-b', currentAccount: true },
                { key: 'a', serverUrl: 'https://a.example.test', accountId: 'account-a', currentAccount: true },
            ],
            route: request => sessionHttp.handle(request.url) ?? undefined,
        });
        serverIdA = home.homes.a!.id;
        serverIdB = home.homes.b!.id;
        const machineA = createMachineFixture({ id: 'shared-machine', metadata: {
            ...createMachineFixture().metadata!, displayName: 'Home A machine',
        } });
        const machineB = createMachineFixture({ ...machineA, metadata: {
            ...machineA.metadata!, displayName: 'Home B machine',
        } });
        storage.setState({
            sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
            sessionListIndexByServerId: { [serverIdA]: [] }, concurrentSessionListCacheByServerId: {},
            machines: { [machineA.id]: machineA },
            machineListByServerId: { [serverIdA]: [machineA], [serverIdB]: [machineB] },
        });
        permissionRpc.mockResolvedValue(undefined);
        routerPush.mockResolvedValue(undefined);
    });
    afterEach(standardCleanup);
    afterEach(async () => {
        await home.dispose();
        act(() => storage.setState(initialState));
    });

    it('shows a stopped pending-approval row with a resume action instead of an empty group', async () => {
        const session = { ...createPendingPostEndSession(), active: false, presence: 0 };
        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={session}
                serverId={serverIdA}
                permissionRequests={[{
                    id: REQUEST_ID,
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'git status' },
                    createdAt: NOW_MS - 10,
                }]}
                userActionRequests={[]}
            />,
        );
        expect(screen.findByTestId(`inbox.session_attention.${SESSION_ID}`)).not.toBeNull();
        expect(screen.findByTestId('inbox.session_attention.stopped')).not.toBeNull();
        expect(screen.findByTestId('inbox.session_attention.resume')).not.toBeNull();
        await screen.pressByTestIdAsync('inbox.session_attention.resume');
        expect(screen.findByTestId('inbox.session_attention.resume_error')).not.toBeNull();
    });

    it('draws Resume through the canonical operation control with a keyboard-only focus ring', async () => {
        const { createThemeFixture } = await import('@/dev/testkit/fixtures/themeFixtures');
        const focusColor = createThemeFixture().colors.border.focus;
        const session = { ...createPendingPostEndSession(), active: false, presence: 0 };
        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={session}
                serverId={serverIdA}
                permissionRequests={[{
                    id: REQUEST_ID,
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'git status' },
                    createdAt: NOW_MS - 10,
                }]}
                userActionRequests={[]}
            />,
        );
        const resume = () => screen.findByTestId('inbox.session_attention.resume')!;
        const flatten = (style: unknown): Record<string, unknown> => (Array.isArray(style)
            ? style.reduce((acc: Record<string, unknown>, next) => ({ ...acc, ...flatten(next) }), {})
            : ((style as Record<string, unknown> | null | undefined) ?? {}));
        // The pill's painted ring: the shared outline, held off the pill so the page shows through.
        const pillRing = () => {
            const frames = resume().findAll((node) => String(node.type) === 'Animated.View');
            expect(frames).toHaveLength(1);
            const style = flatten(frames[0]!.props.style);
            return style.outlineStyle === 'solid' ? { color: style.outlineColor, gap: style.outlineOffset } : null;
        };
        // The browser's `:focus-visible` verdict: a click leaves focus that does not match it, Tab does.
        const focusedElement = (focusVisible: boolean) => ({
            matches: (selector: string) => selector === ':focus-visible' && focusVisible,
        });

        expect(resume().props.accessibilityLabel).toBe(t('session.pendingActivation.actions.resume'));
        expect(resume().props.accessibilityState).toMatchObject({ busy: false, disabled: false });
        expect(pillRing()).toBeNull();

        await act(async () => {
            resume().props.onFocus?.({ target: focusedElement(false) });
        });
        expect(pillRing()).toBeNull();

        await act(async () => {
            // The ring answers only to keyboard use: the document records Tab before the focus lands.
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            resume().props.onBlur?.({});
            resume().props.onFocus?.({ target: focusedElement(true) });
        });
        expect(pillRing()).toEqual({ color: focusColor, gap: 2 });
    });

    it('opens a stopped secondary-Home session before resuming with Home-scoped settings', async () => {
        const session = { ...createPendingPostEndSession(), active: false, presence: 0, serverId: serverIdB };
        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={session}
                serverId={serverIdB}
                permissionRequests={[{
                    id: REQUEST_ID,
                    tool: 'Bash',
                    kind: 'permission',
                    arguments: { command: 'git status' },
                    createdAt: NOW_MS - 10,
                }]}
                userActionRequests={[]}
            />,
        );
        await screen.pressByTestIdAsync('inbox.session_attention.resume');
        expect(routerPush).toHaveBeenCalledWith(`/session/${SESSION_ID}?serverId=${serverIdB}`);
    });

    it.each([
        {
            decision: 'approve',
            actionTestId: 'permission-footer.allow',
            approved: true,
            rpcDecision: 'approved',
        },
        {
            decision: 'deny',
            actionTestId: 'permission-footer.deny',
            approved: false,
            rpcDecision: 'denied',
        },
    ] as const)(
        'keeps the post-End hidden-session permission actionable for $decision',
        async ({ actionTestId, approved, rpcDecision }) => {
            const session = createPendingPostEndSession();
            storage.getState().applySessions([session]);
            const activity = buildActivityOverviewFromSource({
                source: createActivitySource(session),
                nowMs: NOW_MS,
                directActionsEnabled: true,
            });
            const inbox = buildInboxSessionPresentation({ overview: activity });

            expect(activity.candidates).toEqual([
                expect.objectContaining({
                    sessionId: SESSION_ID,
                    route: `/session/${SESSION_ID}?serverId=${serverIdA}`,
                }),
            ]);
            expect(inbox.sessionsNeedingAttention).toHaveLength(1);

            const attention = inbox.sessionsNeedingAttention[0]!;
            const screen = await renderScreen(
                <InboxSessionAttentionGroupCard
                    identityDisplay="none"
                    connected={false}
                    session={attention.candidate.session}
                    serverId={attention.candidate.address?.serverId ?? null}
                    permissionRequests={attention.pendingPermissions}
                    userActionRequests={attention.pendingUserActions}
                />,
            );

            await pressTestInstanceAsync(
                screen.find((node) => node.props.accessibilityLabel === t('inbox.openSession', { session: 'Global Voice session' })),
                'post-End hidden Voice session open action',
            );

            expect(routerPush).toHaveBeenCalledTimes(1);
            expect(routerPush).toHaveBeenCalledWith(
                `/session/${SESSION_ID}?serverId=${serverIdA}`,
            );

            await screen.pressByTestIdAsync(actionTestId);

            expect(screen.findByTestId('permission-footer.action-error')).toBeNull();
            expect(permissionRpc).toHaveBeenCalledTimes(1);
            expect(permissionRpc).toHaveBeenCalledWith(expect.objectContaining({
                serverUrl: 'https://a.example.test',
                method: `${SESSION_ID}:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
                params: {
                    id: REQUEST_ID,
                    approved,
                    decision: rpcDecision,
                    answeringClientCategory: 'web',
                },
            }));
            expect(routerPush).toHaveBeenCalledTimes(1);
        },
    );

    it('sends a secondary Home approval with its qualified scope when the active Home has the same session id', async () => {
        const activeSession = createPendingPostEndSession();
        const secondarySession = { ...activeSession, serverId: serverIdB };
        storage.getState().applySessions([activeSession]);
        storage.setState({ sessionListRowsByServerId: {
            [serverIdA]: { [activeSession.id]: buildSessionListRenderableFromSession(activeSession) },
            [serverIdB]: { [secondarySession.id]: buildSessionListRenderableFromSession(secondarySession) },
        } });
        const activity = buildActivityOverviewFromSource({
            source: createActivitySource(secondarySession),
            nowMs: NOW_MS,
            directActionsEnabled: true,
        });
        const inbox = buildInboxSessionPresentation({ overview: activity });
        const attention = inbox.sessionsNeedingAttention[0]!;
        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={attention.candidate.session}
                serverId={serverIdB}
                permissionRequests={attention.pendingPermissions}
                userActionRequests={attention.pendingUserActions}
            />,
        );

        const { SessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
        expect(screen.findAllByType(SessionTranscriptSourceProvider).map((root) => root.props.source)).toEqual([
            expect.objectContaining({ kind: 'app', sessionId: SESSION_ID, serverId: serverIdB }),
        ]);
        await screen.pressByTestIdAsync('permission-footer.allow');

        expect(permissionRpc).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://b.example.test',
            method: `${SESSION_ID}:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
            params: { id: REQUEST_ID, approved: true, decision: 'approved', answeringClientCategory: 'web' },
        }));
    });

    it('uses the qualified Home when resolving Inbox machine context', async () => {
        const session = createSessionFixture({
            id: 'same-session',
            encryptionMode: 'plain',
            serverId: serverIdB,
            metadata: {
                name: 'Secondary Home session',
                host: 'home-b-host',
                path: '/Users/tester/project',
                homeDir: '/Users/tester',
                machineId: 'shared-machine',
            },
        });

        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={session}
                serverId={serverIdB}
                contextLine="Home B"
                permissionRequests={[]}
                userActionRequests={[]}
            />,
        );

        expect(screen.getTextContent()).toContain('Home B machine');
        expect(screen.getTextContent()).not.toContain('Home A machine');
    });

    it('does not invent raw path context when Activity supplies no resolved context line', async () => {
        const session = createSessionFixture({
            id: 'session-without-context',
            encryptionMode: 'plain',
            serverId: 'server-b',
            metadata: {
                name: 'Secondary Home session',
                path: '/Users/tester/private-project',
                host: 'tester.local',
                homeDir: '/Users/tester',
                machineId: 'shared-machine',
            },
        });

        const screen = await renderScreen(
            <InboxSessionAttentionGroupCard
                identityDisplay="none"
                connected={false}
                session={session}
                serverId="server-b"
                contextLine={null}
                permissionRequests={[]}
                userActionRequests={[]}
            />,
        );

        expect(screen.getTextContent()).not.toContain('private-project');
        expect(screen.getTextContent()).not.toContain('/Users/tester/private-project');
    });
});
