import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createSessionMessagesFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol/sessions/listing/response');
const { AgentStateSchema } = await import('@happier-dev/session-core/state');
const { SessionActionConfirmationRequestV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
const { AppSessionTranscriptSourceProvider } = await import('@/components/sessions/transcript/source/appSessionTranscriptSource');
const { useSessionTranscriptSource } = await import('@/components/sessions/transcript/source/SessionTranscriptSourceContext');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { SessionPendingPromptCards } = await import('@/components/tools/shell/permissions/SessionPendingPromptCards');
const { invokeNextPendingRequest, usePendingNavigationLanding } = await import('@/activity/source/pendingNavigationRuntime');
const { NextPendingNavigationHost } = await import('./NextPendingNavigationHost');
const { PendingNavigationPill } = await import('./PendingNavigationPill');
const initialState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let answerRpc: Parameters<typeof installSessionActionRpcBoundary>[0] = () => { throw new Error('Unexpected Session RPC'); };
// Install before restoring the Account: its persistent Socket must use this same external responder.
const responses = installSessionActionRpcBoundary((request, context) => answerRpc(request, context));

beforeEach(() => { vi.stubGlobal('window', new EventTarget()); });
afterEach(async () => {
    standardCleanup();
    vi.unstubAllGlobals();
    await connection?.dispose();
    connection = undefined;
    responses.length = 0;
    answerRpc = () => { throw new Error('Unexpected Session RPC'); };
    storage.setState(initialState, true);
    await homes.reset();
});

describe('Next focus across workspace navigation updates', () => {
    it.each(['question', 'permission', 'action'] as const)(
        'keeps the landing through hydration, offers Next after answering, and focuses the next %s', async (kind) => {
            const serverUrl = 'https://next-focus.test';
            const serverId = await homes.addHome({ name: 'Next focus', serverUrl, accountId: 'focus-owner' });
            await homes.selectHomes([serverId]);
            connection = await restoreServerAccountForTest({ serverUrl, accountId: 'focus-owner', request: homes.request });
            const now = Date.now();
            const questionArguments = { questions: [{ id: 'answer', question: 'Describe your choice', selection: 'text', required: true }] };
            const firstState = AgentStateSchema.parse({ requests: {
                first: { tool: 'AskUserQuestion', kind: 'user_action', arguments: questionArguments, createdAt: now - 20 },
            } });
            const nextRequest = kind === 'question'
                ? { tool: 'AskUserQuestion', kind: 'user_action', arguments: questionArguments }
                : kind === 'permission'
                    ? { tool: 'Read', kind: 'permission', arguments: { file_path: '/tmp/note.txt' } }
                    : SessionActionConfirmationRequestV1Schema.parse({
                        tool: 'Happier Action confirmation', kind: 'user_action', source: 'happier_action', turnId: 'turn-2', createdAt: now - 10,
                        arguments: { actionId: 'session.title.set', sessionId: 'second', turnId: 'turn-2', preview: { summary: 'Name the session' } },
                        responseTarget: { kind: 'happier_action_confirmation_v1', requestId: 'second', actionId: 'session.title.set',
                            inputDigestV1: `sha256:${'0'.repeat(64)}`, runtimeAccountId: 'focus-owner', sessionId: 'second', turnId: 'turn-2' },
                    });
            const secondState = AgentStateSchema.parse({ requests: { second: { ...nextRequest, createdAt: now - 10 } } });
            const sessions = {
                first: createSessionFixture({ id: 'first', serverId, active: true, activeAt: now, updatedAt: now,
                    metadata: { path: '/tmp', host: 'test', flavor: 'claude' }, agentState: firstState }),
                second: createSessionFixture({ id: 'second', serverId, active: true, activeAt: now, updatedAt: now,
                    metadata: { path: '/tmp', host: 'test', flavor: 'claude' }, agentState: secondState }),
            };
            function publish() {
                const wires = Object.values(sessions).map(session => {
                    const waiting = Object.keys(session.agentState?.requests ?? {}).length;
                    session.pendingPermissionRequestCount = session.id === 'second' && kind !== 'question' ? waiting : 0;
                    session.pendingUserActionRequestCount = session.pendingPermissionRequestCount ? 0 : waiting;
                    session.pendingRequestObservedAt = now;
                    const reason = session.pendingPermissionRequestCount ? 'permission_required' : 'user_action_required';
                    session.viewer = createSessionViewerFixture({
                        relevance: { relevant: true, reasons: ['owned_by_me'] },
                        ...(waiting ? { attention: { needsAttention: true, reasons: [reason], primary: reason, presentation: 'full' } } : {}),
                    });
                    return SessionCurrentProjectionRecordV1Schema.parse({
                        ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata),
                        agentState: JSON.stringify(session.agentState), dataEncryptionKey: null, share: null,
                        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
                        responsibleAccountId: null, responsibleAccount: null,
                    });
                });
                for (const wire of wires) homes.answer(serverId, `/v2/sessions/${wire.id}`, { body: { session: wire } });
                homes.answer(serverId, '/v2/sessions/active', { body: { sessions: wires, hasNext: false, nextCursor: null } });
                storage.setState({ isDataReady: true, profileScope: { serverId, accountId: 'focus-owner' }, sessions: { ...sessions },
                    sessionListRowsByServerId: { [serverId]: Object.fromEntries(Object.values(sessions)
                        .map(session => [session.id, buildSessionListRenderableFromSession(session)])) },
                    ordinarySessionListMembershipByServerId: { [serverId]: ['first', 'second'] },
                });
            }
            publish();
            answerRpc = request => {
                if (request.method.endsWith('session.user_action.answer')) {
                    sessions.first = { ...sessions.first, agentState: AgentStateSchema.parse({ requests: {} }) };
                    publish();
                    return { ok: true };
                }
                throw new Error(`Unexpected Session RPC: ${request.method}`);
            };
            const routes: string[] = [];
            let focusedControl = 'app-rail:search';
            let focusCount = 0;
            let loaded = false;
            let currentId: keyof typeof sessions = 'first';
            let bindingReady = false;
            function Destination() {
                const source = useSessionTranscriptSource();
                bindingReady = useServerCredentialAccountScopeBindings([serverId]).get(serverId)?.isCurrent() === true;
                const requests = source.usePendingRequests();
                const landing = usePendingNavigationLanding({ serverId, sessionId: currentId });
                return <>
                    <PendingNavigationPill address={{ serverId, sessionId: currentId }} presentation="composer" />
                    <React.Fragment>{loaded && landing ? <SessionPendingPromptCards testID="pending-cards"
                        serverId={serverId} sessionId={currentId} session={sessions[currentId]}
                        permissions={requests.permissionRequests} userActions={requests.userActionRequests} /> : null}</React.Fragment>
                </>;
            }
            // The workspace replaces its navigation value as the active destination changes.
            // Keep the real host/router and registration lifecycle; only platform navigation is supplied.
            const tree = () => <DestinationInstanceHost tabId="next-focus" ref={{ kind: 'session', params: { id: currentId, serverId } }}
                pathname={`/session/${currentId}`} focused visible navigation={{
                    push: href => { routes.push(String(href)); }, replace: () => {}, back: () => {},
                }}>
                <AppPaneProvider><KeyboardShortcutProvider handlers={{}}>
                    <NextPendingNavigationHost />
                    <AppSessionTranscriptSourceProvider sessionId={currentId} serverId={serverId}>
                        <Destination />
                    </AppSessionTranscriptSourceProvider>
                </KeyboardShortcutProvider></AppPaneProvider>
            </DestinationInstanceHost>;
            const screen = await renderScreen(tree(), { createNodeMock: element => {
                const id = element.props.testID;
                if (!['ask-user-question.freeform:0', 'permission-footer.allow', 'action-confirmation-approve'].includes(String(id))) return null;
                return { focus: () => { focusedControl = String(id); focusCount++; } };
            } });
            await waitForHomeGovernance(() => expect(bindingReady).toBe(true));
            await React.act(async () => {
                expect(await invokeNextPendingRequest({ excluding: null })).toEqual({ status: 'opened' });
            });
            expect(routes.at(-1)).toBe(`/session/first?serverId=${encodeURIComponent(serverId)}`);
            // Route commit precedes the mounted answer. Rebinding must not consume its landing.
            await screen.update(tree());
            expect(focusedControl).toBe('app-rail:search');
            loaded = true;
            await React.act(async () => {
                storage.setState({ sessionMessages: { first: createSessionMessagesFixture({ isLoaded: true }) } });
            });
            await screen.update(tree());
            expect(focusedControl).toBe('ask-user-question.freeform:0');
            expect(focusCount).toBe(1);
            expect(responses).toHaveLength(0);
            await React.act(async () => { screen.changeTextByTestId('ask-user-question.freeform:0', 'River'); });
            expect(screen.findHostByTestId('ask-user-question.submit')?.props.disabled).toBe(false);
            await screen.pressByTestIdAsync('ask-user-question.submit');
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('pending-navigation-composer')).not.toBeNull());
            expect(responses).toHaveLength(1);
            // A subsequent workspace render must retain the post-answer offer too.
            await screen.update(tree());
            expect(screen.findHostByTestId('pending-navigation-composer')).not.toBeNull();
            await screen.pressByTestIdAsync('pending-navigation-composer');
            expect(routes.at(-1)).toBe(`/session/second?serverId=${encodeURIComponent(serverId)}`);
            currentId = 'second';
            focusedControl = 'app-rail:search';
            await screen.update(tree());
            expect(focusedControl).toBe(kind === 'question' ? 'ask-user-question.freeform:0'
                : kind === 'permission' ? 'permission-footer.allow' : 'action-confirmation-approve');
            expect(focusCount).toBe(2);
            expect(responses).toHaveLength(1);
        },
    );
});
