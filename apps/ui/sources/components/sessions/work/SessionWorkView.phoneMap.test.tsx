import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';

import { createDeferred, createMachineFixture, createSessionFixture, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { installSessionSubagentCommonModuleMocks } from '@/components/sessions/agents/sessionSubagentTestHelpers';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const routerPush = vi.hoisted(() => vi.fn());

installSessionSubagentCommonModuleMocks({
    storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const dimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
        return createReactNativeWebMock({
            Dimensions: { get: () => dimensions, addEventListener: () => ({ remove() {} }) },
            useWindowDimensions: () => dimensions,
        });
    },
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/session/lead', router: { push: routerPush } }).module;
});
installDisconnectedServerSocketBoundary();

const { createWorkflowActionHttpTransport } = await import('@/dev/testkit/fixtures/workflowActionHttpTransport');
const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { SurfaceFreshnessLine } = await import('@/components/ui/surfaces/SurfaceFreshnessLine');
const { resolveServerScopedMachine } = await import('@/sync/domains/machines/resolveServerScopedMachine');

// Keep the Work producer, launcher, selectors, pane and header publication real.
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { storage } = await import('@/sync/domains/state/storage');
const syncRuntime = await import('@/sync/sync');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { PaneHeaderSlotProvider, PaneHeaderSlotScope, usePublishedPaneHeaderContent } = await import('@/components/appShell/panes/paneHeaderSlot');
const { PaneHeader } = await import('@/components/appShell/panes/PaneHeader');
const { PaneHeaderActions } = await import('@/components/appShell/panes/PaneHeaderActions');
const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
const { useSessionAgentActivity } = await import('@/hooks/session/useSessionAgentActivity');
const { SessionWorkSourcesProvider, useSessionWorkSourcesOwner } = await import('./sessionWorkSources');
const { SessionWorkView } = await import('./SessionWorkView');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createExecutionRunLauncherDetailsTab, createInteractiveExecutionRunDraftDetailsTab, createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab } = await import('@/components/sessions/runs/launcher/executionRunLauncherModel');
const { readInteractiveExecutionRunDraftNavigationIntent } = await import('@/components/sessions/runs/launcher/interactiveExecutionRunDraftNavigationIntent');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { ensureSessionDraftRepositoryHydrated, resetSessionDraftRepositoryForTests, writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');

function PaneProbe(props: Readonly<{ onPane: (pane: AppPaneScopeApi) => void }>) {
    const pane = useAppPaneScope('session:lead');
    React.useLayoutEffect(() => props.onPane(pane), [pane, props.onPane]);
    return null;
}

function WorkHeader() {
    const published = usePublishedPaneHeaderContent('work');
    return <PaneHeader size="large" title="Work" line={published?.line} actions={
        <PaneHeaderActions published={published} title="Work" testID="phone-work-header" />
    } />;
}

function WorkHost(props: Readonly<{ serverId: string; onPane?: (pane: AppPaneScopeApi) => void;
    onSources?: (sources: ReturnType<typeof useSessionWorkSourcesOwner>) => void }>) {
    const activity = useSessionAgentActivity({ sessionId: 'lead', serverId: props.serverId });
    const sources = useSessionWorkSourcesOwner({ sessionId: 'lead', serverId: props.serverId,
        ownerMetadata: storage.getState().sessions.lead?.metadata ?? null, agentActivity: activity });
    React.useLayoutEffect(() => props.onSources?.(sources), [props.onSources, sources]);
    return <SessionWorkSourcesProvider value={sources}>
        <AppPaneProvider>
            {props.onPane ? <PaneProbe onPane={props.onPane} /> : null}
            <PaneHeaderSlotProvider>
                <WorkHeader />
                <PaneHeaderSlotScope slotKey="work">
                    <SurfaceStateSizeProvider size="phone">
                        <SessionWorkView sessionId="lead" serverId={props.serverId} scopeId="session:lead" />
                    </SurfaceStateSizeProvider>
                </PaneHeaderSlotScope>
            </PaneHeaderSlotProvider>
        </AppPaneProvider>
    </SessionWorkSourcesProvider>;
}

afterEach(standardCleanup);

describe('phone Work List → Map', () => {
    it('reopens a retained start draft on a phone through the Run page that already shows its draft', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://phone-work-draft.test', serverIdentityId: 'srv_phone_work_draft', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        storage.setState({ sessions: { lead: createSessionFixture({ id: 'lead', serverId }) }, sessionListRowsByServerId: {} });
        let pane: AppPaneScopeApi | undefined;
        const screen = await renderScreen(<WorkHost serverId={serverId} onPane={next => { pane = next; }} />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        try {
            // A phone has no Details tab beside the Session: an unsent start lives in the Session draft and
            // its Run page, the same page "New agent conversation" opens, so reopening lands there.
            const conversation = createInteractiveExecutionRunDraftDetailsTab();
            const plan = createExecutionRunLauncherDetailsTab('plan');
            const secondOpinion = createExecutionRunLauncherDetailsTab('review', { roleId: 'second_opinion', title: 'Second opinion' });
            // A draft started from selected Discussion messages is its own draft, keyed by its correlation.
            const discussionSource = {
                kind: 'discussion' as const, serverId, discussionId: 'discussion_1',
                messageIds: ['message_1'], draftCorrelationId: 'selection_1',
            };
            const discussion = createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab({ source: discussionSource, initialText: 'Investigate this' });
            const otherDiscussion = createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab({
                source: { ...discussionSource, messageIds: ['message_2'], draftCorrelationId: 'selection_2' }, initialText: 'Investigate another selection',
            });
            await act(async () => {
                for (const [key, text] of [
                    ['conversation', 'Plain conversation draft'],
                    ['discussion:selection_1', 'First Discussion draft'],
                    ['discussion:selection_2', 'Second Discussion draft'],
                ]) {
                    writeExistingSessionDraft({ scope: draftScope, sessionId: 'lead', patch: { executionRunLauncher: { key: key!, patch: { text } } } });
                }
                pane!.openDetailsTab(discussion, { intent: 'pinned' });
                pane!.openDetailsTab(otherDiscussion, { intent: 'pinned' });
                pane!.openDetailsTab(conversation, { intent: 'pinned' });
                pane!.openDetailsTab(plan, { intent: 'pinned' });
                pane!.openDetailsTab(secondOpinion, { intent: 'pinned' });
            });
            expect(screen.findByTestId(`session-work-start-draft:${discussion.key}`)?.props.accessibilityLabel).toContain('First Discussion draft');
            expect(screen.findByTestId(`session-work-start-draft:${otherDiscussion.key}`)?.props.accessibilityLabel).toContain('Second Discussion draft');
            const scope = `serverId=${encodeURIComponent(serverId)}`;
            for (const [tab, href] of [
                [conversation, `/session/lead/runs/new?${scope}`],
                [plan, `/session/lead/runs/new?${scope}&intent=plan`],
                [secondOpinion, `/session/lead/runs/new?${scope}&intent=review&roleId=second_opinion`],
                [discussion, `/session/lead/runs/new?${scope}&draftCorrelationId=selection_1`],
                [otherDiscussion, `/session/lead/runs/new?${scope}&draftCorrelationId=selection_2`],
            ] as const) {
                routerPush.mockClear();
                await screen.pressByTestIdAsync(`session-work-start-draft:${tab.key}`);
                expect(routerPush).toHaveBeenCalledTimes(1);
                expect(routerPush).toHaveBeenCalledWith(href);
            }
            // The Run page finds that exact draft through the existing handoff, not the plain conversation draft.
            expect(readInteractiveExecutionRunDraftNavigationIntent({ address: { serverId, sessionId: 'lead' }, correlationId: 'selection_1' }))
                .toEqual({ source: discussionSource, initialText: 'Investigate this' });
            await act(async () => pane!.closeDetailsTab(conversation.key));
            for (const [key, preview] of [
                ['conversation', 'Plain conversation draft'],
                [discussion.key, 'First Discussion draft'],
                [otherDiscussion.key, 'Second Discussion draft'],
            ]) {
                expect(screen.findByTestId(`session-work-start-draft:${key}`)?.props.accessibilityLabel).toContain(preview);
            }
            routerPush.mockClear();
            await screen.pressByTestIdAsync('session-work-start-draft:conversation');
            expect(routerPush).toHaveBeenCalledWith(`/session/lead/runs/new?${scope}`);
        } finally {
            await screen.unmount();
            storage.setState(initial, true);
            await connection.dispose();
        }
    });

    it('lists a start whose unsent text no tab shows, reopens it on the phone, and drops it once cleared', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://phone-work-retained.test', serverIdentityId: 'srv_phone_work_retained', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        storage.setState({ sessions: { lead: createSessionFixture({ id: 'lead', serverId }) }, sessionListRowsByServerId: {} });
        const screen = await renderScreen(<WorkHost serverId={serverId} />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        try {
            expect(screen.findByTestId('session-work-start-draft:plan')).toBeFalsy();
            await act(async () => writeExistingSessionDraft({ scope: draftScope, sessionId: 'lead', patch: { executionRunLauncher: { key: 'plan', patch: { text: 'Plan the migration' } } } }));
            // The row says what the draft says, so a person can tell which unsent start it is.
            expect(screen.getTextContent()).toContain('Plan the migration');
            await act(async () => writeExistingSessionDraft({ scope: draftScope, sessionId: 'lead', patch: { executionRunLauncher: { key: 'plan', patch: { text: 'Plan the   rollout first\nand a second line' } } } }));
            expect(screen.getTextContent()).toContain('Plan the rollout first');
            expect(screen.getTextContent()).not.toContain('second line');
            routerPush.mockClear();
            await screen.pressByTestIdAsync('session-work-start-draft:plan');
            expect(routerPush).toHaveBeenCalledWith(`/session/lead/runs/new?serverId=${encodeURIComponent(serverId)}&intent=plan`);
            await act(async () => writeExistingSessionDraft({ scope: draftScope, sessionId: 'lead', patch: { executionRunLauncher: { key: 'plan', patch: { text: '' } } } }));
            expect(screen.findByTestId('session-work-start-draft:plan')).toBeFalsy();
        } finally {
            await screen.unmount();
            storage.setState(initial, true);
            resetSessionDraftRepositoryForTests();
            await connection.dispose();
        }
    });

    it('renders the same qualified children across a cold credential binding and a settled repeat', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://phone-work-map.test', serverIdentityId: 'srv_phone_work_map', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const lead = createSessionFixture({ id: 'lead', serverId });
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        const child = createSessionFixture({ id: 'child', serverId, manager: { sessionId: lead.id } });
        const foreign = createSessionFixture({ id: 'foreign', serverId: 'another-home', manager: { sessionId: lead.id } });
        storage.setState({ sessions: { lead, child, foreign }, sessionListRowsByServerId: {} });
        const credentials = createDeferred<void>();
        let pendingReads = 0;
        // Credential storage is an external boundary. Restoration is complete; hold only the
        // mounted consumers' cold reads so the first view switch overlaps their publication.
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async () => {
            pendingReads++;
            await credentials.promise;
            return connection.credentials;
        });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(<WorkHost serverId={serverId} />, {
                wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
            });
            expect(pendingReads).toBeGreaterThan(0);
            const switchView = async (view: 'list' | 'map') => {
                const tab = screen!.findByTestId(`session-work-view:${view}`);
                expect(tab).not.toBeNull();
                await pressTestInstanceAsync(tab!);
            };
            await switchView('map');
            expect(screen.findHostByTestId('session-work-map-node-session:child')).not.toBeNull();
            expect(screen.findHostByTestId('session-work-map-node-session:foreign')).toBeNull();
            await act(async () => { credentials.resolve(); await credentials.promise; });
            await switchView('list');
            await switchView('map');
            expect(screen.findHostByTestId('session-work-map-node-session:child')).not.toBeNull();
            expect(screen.findHostByTestId('session-work-map-node-session:foreign')).toBeNull();
        } finally {
            credentialRead.mockRestore();
            credentials.resolve();
            await screen?.unmount();
            storage.setState(initial, true);
            await connection.dispose();
        }
    }, 180_000);
});

describe('Work pane after a child was archived', () => {
    it('says the archived child exists instead of inviting a first start, and offers it back', async () => {
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://work-archived-child.test', serverIdentityId: 'srv_work_archived_child', accountId: 'account',
            request: async url => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
                return Response.json({}, { status: 404 });
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        const lead = createSessionFixture({ id: 'lead', serverId });
        const hydrateRows = vi.spyOn(syncRuntime.sync, 'hydrateSessionListRows').mockResolvedValue(undefined);
        // The empty invitation is only said once the Session's transcript has loaded.
        storage.setState({ sessions: { lead }, sessionListRowsByServerId: {}, sessionMessages: { lead: createSessionMessagesFixture({ isLoaded: true }) } });
        const screen = await renderScreen(<WorkHost serverId={serverId} />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        try {
            // A Session that never started anything keeps its invitation.
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-empty')).not.toBeNull());
            expect(screen.findHostByTestId('session-work-state-archived')).toBeNull();

            const archivedChild = createSessionFixture({ id: 'old-child', serverId, manager: { sessionId: lead.id }, archivedAt: 1_000 });
            await act(async () => storage.setState({ sessions: { lead, 'old-child': archivedChild } }));
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-state-archived')).not.toBeNull());
            expect(screen.findHostByTestId('session-work-empty')).toBeNull();
            expect(screen.findHostByTestId('session-work-unarchive:old-child')).not.toBeNull();
            // The archived row names itself from its own content: the pane demands it like the sidebar does.
            expect(hydrateRows).toHaveBeenCalledWith([{ serverId, sessionId: 'old-child' }]);
            // Nothing live to switch between, so no List | Map (the desktop header follows the same rule).
            expect(screen.findHostByTestId('session-work-view:list')).toBeNull();
            // The header line counts it, where it used to say nothing was started.
            expect(screen.getTextContent()).toContain('sessionWork.subtitle.archived');
            expect(screen.getTextContent()).not.toContain('sessionWork.subtitle.nothingStarted');
        } finally {
            hydrateRows.mockRestore();
            await screen.unmount();
            storage.setState(initial, true);
            resetSessionDraftRepositoryForTests();
            await connection.dispose();
        }
    }, 180_000);
});

describe('Work pane while its machine is not answering', () => {
    it('keeps the last-known rows under one line with the honest time and a Retry that asks the Home again', async () => {
        const requested: string[] = [];
        let runReadFails = false;
        const run = createWorkflowRunSummaryFixture({ id: '11111111-1111-4111-8111-111111111111', ownerAccountId: 'account',
            machineId: 'm1', origin: { kind: 'direct', originSessionId: 'lead' } });
        const boundary = createWorkflowActionHttpTransport({ accountId: () => 'account', fixtureResponse: async (actionId, input) => ({
            ok: true, result: actionId === 'workflow.run.list'
                ? { runs: input.attention ? [] : [run], metadataByRunId: input.attention ? {} : {
                    [run.id]: { kind: 'available', value: { title: 'Retained workflow' } },
                } }
                : { definitions: [], pluginWorkflows: [] },
        }) });
        const connection = await restoreServerAccountForTest({
            serverUrl: 'https://work-machine-offline.test', serverIdentityId: 'srv_work_machine_offline', accountId: 'account',
            configureSocket: configureConnectedServerSocketBoundary,
            credentials: { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
                provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }),
            })).toString('base64url')}.signature` },
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                requested.push(path);
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                    experiments: true, featureToggles: { automations: true },
                } }, version: 1 });
                if (path === '/v1/machines') {
                    return Response.json({}, { status: 503 });
                }
                if (path === '/v3/automations/runs/workflow-storage' && runReadFails) return Response.json({}, { status: 503 });
                return boundary.fetch(url, init);
            },
        });
        const initial = storage.getState();
        const serverId = connection.home.id;
        const draftScope = getActiveServerAccountScope();
        if (!draftScope) throw new Error('Expected the restored Account draft scope');
        await ensureSessionDraftRepositoryHydrated(draftScope);
        const lastHeartbeat = Date.now() - 20 * 60_000;
        const machine = createMachineFixture({ id: 'm1', active: false, activeAt: lastHeartbeat });
        const metadata = { machineId: 'm1', path: '/repo', host: 'host-1' };
        const lead = createSessionFixture({ id: 'lead', serverId, metadata });
        const child = createSessionFixture({ id: 'child', serverId, metadata, manager: { sessionId: lead.id } });
        storage.setState({ sessions: { lead, child }, sessionListRowsByServerId: {},
            settings: { ...initial.settings, experiments: true, featureToggles: { ...initial.settings.featureToggles, automations: true } } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        let observedSources: ReturnType<typeof useSessionWorkSourcesOwner> | undefined;
        const screen = await renderScreen(<WorkHost serverId={serverId} onSources={value => { observedSources = value; }} />, {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>,
        });
        const diagnostic = vi.spyOn(console, 'info');
        try {
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-machine-offline')).not.toBeNull());
            await waitForHomeGovernance(() => expect(observedSources?.managedRuns.phase).toBe('loaded'));
            expect(screen.getTextContent()).toContain('Retained workflow');
            await act(async () => {
                runReadFails = true;
                publishHomeAccountChange(serverId, [`workflow-run:${run.id}`]);
            });
            await waitForHomeGovernance(() => expect(observedSources?.managedRuns.refreshFailed).toBe(true));
            requested.length = 0;
            await screen.pressByTestIdAsync('session-work-machine-offline-action');
            await waitForHomeGovernance(() => expect(requested).toContain('/v1/machines'));
            // The external diagnostic proves the rejected refresh settled before the next press;
            // otherwise the canonical in-flight owner correctly rejoins the still-pending attempt.
            await waitForHomeGovernance(() => expect(diagnostic).toHaveBeenCalledWith(
                '[fireAndForget] SessionWorkView.retryMachineReachability', expect.any(Error)));
            await waitForHomeGovernance(() => {
                expect(screen.findAllByType(SurfaceFreshnessLine).filter(line =>
                    line.props.testID === 'session-work-machine-offline' || line.props.testID === 'session-work-runs-stale')).toHaveLength(1);
                expect(screen.findHostByTestId('session-work-runs-stale')).toBeNull();
            });
            // The rows stay; the line says when they are from instead of leaving the offline state timeless.
            expect(screen.findHostByTestId('session-work-state-recent') ?? screen.findHostByTestId('session-work-state-working')
                ?? screen.findHostByTestId('session-work-state-needsYou')).not.toBeNull();
            expect(screen.getTextContent()).toMatch(/surfaceState\.asOf|As of/);
            // Let the rejecting external read settle: Vitest must report no unhandled rejection.
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-machine-offline-action')).not.toBeNull());
            expect(screen.findHostByTestId('session-work-state-recent') ?? screen.findHostByTestId('session-work-state-working')
                ?? screen.findHostByTestId('session-work-state-needsYou')).not.toBeNull();
            // A second press still reaches the Home and owns another rejection.
            requested.length = 0;
            diagnostic.mockClear();
            await screen.pressByTestIdAsync('session-work-machine-offline-action');
            await waitForHomeGovernance(() => expect(requested).toContain('/v1/machines'));
            await waitForHomeGovernance(() => expect(diagnostic).toHaveBeenCalledWith(
                '[fireAndForget] SessionWorkView.retryMachineReachability', expect.any(Error)));
            expect(screen.getTextContent()).toContain('Retained workflow');
            // Arrange the neighboring reachable-Machine state through its real store owner,
            // just as the initial offline state above; this does not certify census recovery.
            await act(async () => storage.getState().applyMachines([
                createMachineFixture({ id: 'm1', active: true, activeAt: Date.now() }),
            ], false, { sourceServerId: serverId }));
            expect(resolveServerScopedMachine(storage.getState(), serverId, 'm1')?.active).toBe(true);
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-machine-offline')).toBeNull());
            // A reachable Machine must not hide the independent retained Run failure.
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-runs-stale')).not.toBeNull());
            runReadFails = false;
            await screen.pressByTestIdAsync('session-work-runs-stale-action');
            await waitForHomeGovernance(() => expect(screen.findHostByTestId('session-work-runs-stale')).toBeNull());
            expect(screen.getTextContent()).toContain('Retained workflow');
        } finally {
            diagnostic.mockRestore();
            await screen.unmount();
            storage.setState(initial, true);
            await connection.dispose();
        }
    }, 180_000);
});
