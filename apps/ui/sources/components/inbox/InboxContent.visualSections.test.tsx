import * as React from 'react';
import { StyleSheet as NativeStyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createAutomationRunFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createInboxAttentionFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { EMPTY_WORKFLOW_ATTENTION_SOURCE } from '@/hooks/inbox/useWorkflowAttentionSource';
import { buildServerScopedSessionKey } from '@/sync/domains/session/navigation/sessionNavigationOrder';
import type { Session } from '@/sync/domains/state/storageTypes';
import { workflowRunRowFromAutomationRun, workflowRunRowFromSummary, type WorkflowRunRow } from '@/sync/store/domains/workflowRuns';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';

import type { InboxModel } from '@/hooks/inbox/useInboxModel';

const routerPush = vi.hoisted(() => vi.fn());
const identityState = vi.hoisted(() => ({ display: 'agentLogo' as 'agentLogo' | 'none' }));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/components/ui/selectionList/SelectionListSectionHeader', () => ({
    SelectionListSectionHeader: (props: Record<string, unknown>) => React.createElement(
        'SelectionListSectionHeader', props, props.rightAccessory as React.ReactNode,
    ),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown>) => React.createElement(
        'ItemGroup', props, props.action as React.ReactNode, props.children as React.ReactNode,
    ),
}));
vi.mock('@/components/ui/lists/SectionActionButton', () => ({ SectionActionButton: 'SectionActionButton' }));
vi.mock('@/components/ui/surfaces/SurfaceFreshnessLine', () => ({ SurfaceFreshnessLine: 'SurfaceFreshnessLine' }));
vi.mock('@/components/ui/empty/EmptyState', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/icons/Icon', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/ui/icons/Icon')>(),
    Icon: 'Icon',
}));
vi.mock('@/components/ui/feedback/ActivitySpinner', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/ui/feedback/ActivitySpinner')>(),
    ActivitySpinner: 'ActivitySpinner',
}));
vi.mock('@/components/ui/cards/UserCard', () => ({ UserCard: 'UserCard' }));
vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({ RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner' }));
vi.mock('@/components/inbox/cards/ApprovalInboxCard', () => ({ ApprovalInboxCard: 'ApprovalInboxCard' }));
vi.mock('@/components/inbox/sessionAttention/InboxSessionAttentionGroupCard', () => ({ InboxSessionAttentionGroupCard: 'InboxSessionAttentionGroupCard' }));
vi.mock('@/components/sessions/shell/SessionListIdentity', () => ({
    SessionListIdentity: 'SessionListIdentity',
    useSessionListIdentityDisplay: () => identityState.display,
}));
vi.mock('@/components/sessions/shell/resolveSessionListDensityViewState', () => ({
    SESSION_LIST_ROW_IDENTITY_METRICS: { compact: { slotSize: 30, agentLogoSize: 23 } },
}));
vi.mock('./workGroups/InboxSessionRowMenu', () => ({ InboxSessionRowMenu: 'InboxSessionRowMenu' }));
vi.mock('@/utils/platform/responsive', () => ({ useIsTablet: () => true }));
vi.mock('./InboxReadySessionRow', () => ({ InboxReadySessionRow: 'InboxReadySessionRow' }));
vi.mock('./actionOperations/ActionOperationLedger', () => ({ ActionOperationRows: 'ActionOperationRows' }));
vi.mock('./actionOperations/actionOperationPresentationRuntime', () => ({ openActionOperation: vi.fn() }));
// Cold external Socket transport; Account restoration and Action owners stay real.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function storedSession(id: string, facts: Readonly<{ lead?: string; reports?: number; turn?: Session['latestTurnStatus'] }> = {}): Session {
    return createSessionFixture({
        id,
        serverId: 'server-a',
        encryptionMode: 'plain',
        encryptedContentAvailability: 'ready',
        active: false,
        presence: 'online',
        updatedAt: NOW - 3 * 60_000,
        ...(facts.lead ? { reportsTo: { sessionId: facts.lead } } : {}),
        ...(facts.reports ? { reports: { total: facts.reports, working: 1, needsYou: 1, stalled: 1 } } : {}),
        ...(facts.turn ? { latestTurnStatus: facts.turn } : {}),
    });
}

function candidate(session: Session, attentionState: string, reasons: readonly string[]) {
    return {
        sessionId: session.id,
        serverId: 'server-a',
        address: { serverId: 'server-a', sessionId: session.id },
        session,
        awareness: projectUiSessionAwareness(session, NOW),
        title: `Session ${session.id}`,
        subtitle: `/workspace/${session.id}`,
        context: { contextLine: `Home · ${session.id}`, segments: [{ kind: 'home', label: 'Home' }, { kind: 'workspace', label: session.id }] },
        route: `/session/${session.id}`,
        attentionState,
        personalAttention: { reasons, presentation: 'full' },
    } as never;
}

const lead = storedSession('lead', { reports: 3 });
const worker = storedSession('worker', { lead: 'lead' });
const stalledWorker = storedSession('stalled-worker', { lead: 'lead' });
const stopped = storedSession('stopped');
const failed = storedSession('failed', { turn: 'failed' });
const snoozed = storedSession('snoozed');
const sessions = new Map([lead, worker, stalledWorker, stopped, failed, snoozed].map((value) => [value.id, value]));

function createModel(options: Readonly<{
    openApprovals?: ReadonlyArray<Readonly<{ id: string; header: Record<string, unknown> }>>;
    workflowStale?: boolean;
    needsYou?: boolean;
    /** Further runs with no orchestrator, after `library-run`. */
    moreRunIds?: readonly string[];
    /** A run's own state, where it is not the default held `interrupted`. */
    runStates?: Readonly<Record<string, 'cancelled' | 'succeeded' | 'interrupted'>>;
    automationRunRows?: readonly WorkflowRunRow[];
    /** The step a run's summary says waits, with its lane. */
    heldStep?: Readonly<{ invocationId: string; label: string; laneLabel?: string }>;
}> = {}): InboxModel {
    const needsYou = options.needsYou ?? true;
    const attention = createInboxAttentionFixture('server-a');
    const sessionEntries = needsYou ? [
        // A worker permission prompt and a stopped session's pending request (A17: "Resume").
        { candidate: candidate(worker, 'action_required', ['permission_required']), pendingPermissions: [{ id: 'p-worker' }], pendingUserActions: [] },
        { candidate: candidate(stopped, 'action_required', ['permission_required']), pendingPermissions: [{ id: 'p-stopped' }], pendingUserActions: [] },
        { candidate: candidate(failed, 'failed', ['failed']), pendingPermissions: [], pendingUserActions: [] },
    ] : [];
    const readySession = storedSession('ready');
    const ready = candidate(readySession, 'ready', ['unread']);
    const readyTarget = {
        key: buildServerScopedSessionKey('ready', 'server-a'),
        sessionId: 'ready',
        serverId: 'server-a',
        readState: 'unread',
    };
    const approvals = needsYou ? (options.openApprovals ?? [{ id: 'approval-1', header: {} }]) : [];
    const workGroups = buildInboxWorkGroups({
        sessionEntries: sessionEntries as never,
        workflowRuns: needsYou ? ['library-run', ...(options.moreRunIds ?? [])].map((id) => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
            id,
            state: options.runStates?.[id] ?? 'interrupted',
            updatedAt: '2026-09-30T11:54:00.000Z',
            ...(options.heldStep && id === 'library-run' ? { heldStep: options.heldStep } : {}),
        }), null)) : [],
        automationRuns: options.automationRunRows ?? [],
        automationServerId: 'server-a',
        openApprovals: approvals as never,
        stalledSessions: needsYou ? [stalledWorker] : [],
        landings: [],
        snoozed: needsYou ? [{ session: snoozed, remindAt: NOW + 3_600_000 }] : [],
        resolveSession: (id) => sessions.get(id),
        resolveOriginRunId: () => null,
    });
    return {
        source: {},
        openApprovals: approvals,
        openUsageNotices: [],
        dismissUsageNotice: vi.fn(async () => {}),
        friendRequests: [{ id: 'friend-1', username: 'friend' }],
        sessionPresentation: {
            sessionsNeedingAttention: sessionEntries,
            readySessions: [ready],
            markAllReadTargets: [readyTarget],
            pendingRequestHydrationTargets: [],
        },
        targetBySessionAddress: new Map([[readyTarget.key, readyTarget]]),
        actionOperationEntries: needsYou ? [{
            reason: 'failed',
            operation: { serverId: 'server-a', snapshot: { operationId: 'op-failed' } },
        }] : [],
        pendingReadKeys: new Set(),
        markAllPending: false,
        isLoading: false,
        hasPrimaryAttention: true,
        showCaughtUp: false,
        markRead: vi.fn(async () => {}),
        resolveActionOperation: vi.fn(),
        workGroups,
        spansHomes: true,
        ...attention,
        workflowAttention: options.workflowStale
            ? { ...attention.workflowAttention, available: true, phase: 'loaded', refreshFailed: true,
                runIds: needsYou ? ['library-run'] : [], knownAt: NOW - 60_000 }
            : attention.workflowAttention,
        settle: vi.fn(async () => {}),
        setReminder: vi.fn(async () => {}),
    } as unknown as InboxModel;
}

type Node = { props: Record<string, unknown>; findAll: (predicate: (node: Node) => boolean) => readonly Node[] };

function groupOrder(tree: { root: Node }): string[] {
    return Array.from(new Set(tree.root
        .findAll((node) => typeof node.props.testID === 'string' && /^inbox\.group\.[a-z:_-]+$/.test(node.props.testID))
        .map((node) => String(node.props.testID))));
}

describe('InboxContent grouped by work root (ORC R-10, lab inbox-I1)', () => {
    it.each(['screen', 'popover'] as const)('renders Automation-only attention and its route in the %s', async (presentation) => {
        const { InboxContent } = await import('./InboxContent');
        const run = createAutomationRunFixture({ id: 'pre-session', state: 'failed' });
        const route = { pathname: '/automations/[id]/runs/[runId]' as const, params: { id: run.automationId, runId: run.id } };
        const model = { ...createModel({ needsYou: false, automationRunRows: [workflowRunRowFromAutomationRun(run)] }), friendRequests: [],
            sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] },
            automationAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'loaded' as const, runIds: [run.id], knownAt: NOW },
            automationAttentionItems: [{ key: `automation-run:${run.id}`, run, route }],
        };
        const screen = await renderScreen(<InboxContent model={model} presentation={presentation} />);
        const row = screen.findByTestId(`inbox.automation_run.${run.id}`);
        expect(row).not.toBeNull();
        expect(screen.findByTestId('inbox.empty')).toBeNull();
        row!.props.onPress();
        expect(routerPush).toHaveBeenCalledWith(route);
    });

    it.each(['screen', 'popover'] as const)('does not claim caught up after an initial Automation failure in the %s', async (presentation) => {
        const { InboxContent } = await import('./InboxContent');
        const retry = vi.fn();
        const model = { ...createModel({ needsYou: false }), friendRequests: [],
            sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] },
            automationAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'failed' as const, retry },
        };
        const screen = await renderScreen(<InboxContent model={model} presentation={presentation} />);
        expect(screen.findByTestId('inbox.empty')).toBeNull();
        const button = screen.findByTestId('inbox.automation_retry');
        expect(button).not.toBeNull();
        button!.props.onPress();
        expect(retry).toHaveBeenCalledOnce();
    });

    it('retains a stale Automation row and retries its own source, not Workflows', async () => {
        const { InboxContent } = await import('./InboxContent');
        const run = createAutomationRunFixture({ id: 'known-failure', state: 'failed' });
        const retry = vi.fn();
        const workflowRetry = vi.fn();
        const model = { ...createModel({ needsYou: false, automationRunRows: [workflowRunRowFromAutomationRun(run)] }),
            workflowAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, retry: workflowRetry },
            automationAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'loaded' as const,
                refreshFailed: true, runIds: [run.id], knownAt: NOW - 60_000, retry },
            automationAttentionItems: [{ key: `automation-run:${run.id}`, run,
                route: { pathname: '/automations/[id]/runs/[runId]' as const, params: { id: run.automationId, runId: run.id } } }],
        };
        const screen = await renderScreen(<InboxContent model={model} />);
        expect(screen.findByTestId(`inbox.automation_run.${run.id}`)).not.toBeNull();
        const stale = screen.findByTestId('inbox.automation_stale');
        expect(stale?.props.asOf).toBe(NOW - 60_000);
        stale!.props.action.onPress();
        expect(retry).toHaveBeenCalledOnce();
        expect(workflowRetry).not.toHaveBeenCalled();
    });
    beforeEach(async () => {
        identityState.display = 'agentLogo';
        routerPush.mockClear();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://server-a', accountId: 'account-a',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json({
                    mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
                    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
                });
                if (path === '/v3/automations/runs/workflow-storage') {
                    const operation = JSON.parse(String(init?.body)) as { operation: string };
                    if (operation.operation === 'invocations.list') return Response.json({ invocations: [], parentRevision: 0 });
                }
                return new Response('{}', { status: 404 });
            },
        });
        vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    });
    afterEach(async () => {
        await standardCleanup();
        vi.useRealTimers();
        await connection?.dispose();
        connection = null;
    });

    it('updates an unchanged Automation attention row age on the shared clock and keeps its open target', async () => {
        const { InboxContent } = await import('./InboxContent');
        const run = createAutomationRunFixture({ id: 'aging-run', state: 'failed', finishedAt: NOW - 60_000 });
        const route = { pathname: '/automations/[id]/runs/[runId]' as const, params: { id: run.automationId, runId: run.id } };
        const base = createModel({ needsYou: false, automationRunRows: [workflowRunRowFromAutomationRun(run)] });
        const model = { ...base, automationAttentionItems: [{ key: `automation-run:${run.id}`, run, route }],
            automationAttention: { ...base.automationAttention, available: true, phase: 'loaded' as const, runIds: [run.id] } };
        const screen = await renderScreen(<InboxContent model={model} />);
        expect(screen.getTextContent()).toContain('1m');
        await act(async () => { vi.advanceTimersByTime(60_000); });
        expect(screen.getTextContent()).toContain('2m');
        await screen.pressByTestIdAsync(`inbox.automation_run.${run.id}`);
        expect(routerPush).toHaveBeenCalledWith(route);
        await screen.unmount();
    });

    it('renders one section per work root, with its mark, name, one quiet fact and Open, Other sessions last', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} />);

        expect(groupOrder(tree as never)).toEqual([
            'inbox.group.lead:lead',
            'inbox.group.run:library-run',
            'inbox.group.other',
        ]);
        const groups = tree.root.findAllByType('ItemGroup' as never);
        expect(groups).toHaveLength(3);
        expect(groups[2]?.props.title).toBe('inbox.work.groups.otherTitle');
        expect(groups[0]?.props.titleLeading).toBeTruthy();
        expect(groups[0]?.props.action).toBeTruthy();
        expect(groups[2]?.props.action).toBeUndefined();

        // The worker's prompt keeps the canonical answer card inside its lead's section.
        const leadSection = tree.root.findByProps({ testID: 'inbox.group.lead:lead' });
        expect(leadSection.findAllByType('InboxSessionAttentionGroupCard').map((card) => card.props.session.id)).toEqual(['worker']);
        expect(leadSection.findByProps({ testID: 'inbox.stalled.stalled-worker' }).props.facts)
            .toEqual(['inbox.work.rows.stalled', 'inbox.work.rows.stalledReason']);

        // An interrupted run with no orchestrator is its own root, reviewed from its row.
        await tree.pressByTestIdAsync('inbox.run.library-run.review');
        await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith(expect.stringContaining('library-run')));

        // Approvals and operations belong to Other sessions, beside loose sessions.
        const other = tree.root.findByProps({ testID: 'inbox.group.other' });
        expect(other.findAllByType('ApprovalInboxCard')).toHaveLength(1);
        expect(other.findAllByType('ActionOperationRows')).toHaveLength(1);
        expect(tree.root.findAllByType('InboxReadySessionRow')).toHaveLength(0);
    });

    it('opens a run group header on the workflow attention window’s exact Home', async () => {
        const { InboxWorkGroupSection } = await import('./workGroups/InboxWorkGroupSection');
        const base = createModel();
        const model = { ...base, workflowAttention: { ...base.workflowAttention, serverId: 'home/1 a' } };
        const group = model.workGroups.find((entry) => entry.root.kind === 'run')!;
        // A run which leads with its own row is headerless. Exercise the section's declared
        // run-header input without that row; the route still belongs to the window's Home.
        const screen = await renderScreen(<InboxWorkGroupSection
            group={{ ...group, items: [] }}
            model={model}
            identityDisplay="agentLogo"
            presentation="screen"
            navigate={routerPush}
        />);

        screen.findByTestId(`inbox.group.${group.key}.open`)!.props.onPress();
        expect(routerPush).toHaveBeenCalledWith('/workflows/runs/library-run?serverId=home%2F1%20a');
    });

    it('keeps runs that are their own root in one sheet, rather than one card per run', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel({ moreRunIds: ['second-run', 'third-run'] })} />);

        // Lead, the runs, Other sessions: three sheets, not five.
        expect(tree.root.findAllByType('ItemGroup' as never)).toHaveLength(3);
        const runs = tree.root.findByProps({ testID: 'inbox.group.run:library-run' });
        for (const id of ['library-run', 'second-run', 'third-run']) {
            expect(runs.findByProps({ testID: `inbox.run.${id}.review` })).toBeTruthy();
        }
    });

    it('opens a stopped run rather than offering to review it (DESIGN-14 D8)', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel({
            moreRunIds: ['stopped-run'], runStates: { 'stopped-run': 'cancelled' },
        })} />);

        expect(tree.root.findByProps({ testID: 'inbox.run.library-run.review' }).props.title).toBe('inbox.work.rows.review');
        expect(tree.root.findByProps({ testID: 'inbox.run.stopped-run.review' }).props.title).toBe('inbox.work.groups.openRun');
    });

    it('marks the one item the person came to see (Boards opens the Inbox item, INT §5.1)', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { createInboxItemRoute, readInboxItemFocus } = await import('./inboxItemFocus');
        const selectedRows = (tree: { root: Node }) => Array.from(new Set(tree.root
            .findAll((node) => typeof node.props.testID === 'string' && node.props.selected === true)
            .map((node) => String(node.props.testID))));

        const runRoute = createInboxItemRoute({ kind: 'workflow_run', serverId: 'server-a', id: 'library-run' });
        expect(runRoute.pathname).toBe('/inbox');
        const model = createModel();
        const run = await renderScreen(<InboxContent model={{ ...model, workflowAttention: { ...model.workflowAttention, serverId: 'server-a' } }} focusedItem={readInboxItemFocus(runRoute.params.item)} />);
        expect(selectedRows(run.tree as never)).toEqual(['inbox.run.library-run']);

        const sessionRoute = createInboxItemRoute({ kind: 'session', serverId: 'server-a', id: 'stalled-worker' });
        const session = await renderScreen(<InboxContent model={createModel()} focusedItem={readInboxItemFocus([sessionRoute.params.item])} />);
        expect(selectedRows(session.tree as never)).toEqual(['inbox.stalled.stalled-worker']);

        const none = await renderScreen(<InboxContent model={createModel()} />);
        expect(selectedRows(none.tree as never)).toEqual([]);

        const invalid = await renderScreen(<InboxContent model={createModel()} focusedItem={readInboxItemFocus('session: ')} />);
        expect(selectedRows(invalid.tree as never)).toEqual([]);
    });

    it('beside its detail pane, a row selects its item instead of leaving the Inbox (lab inbox-I1)', async () => {
        const { InboxContent } = await import('./InboxContent');
        const selected: unknown[] = [];
        const model = createModel({ openApprovals: [{ id: 'approval-1', header: { serverIdentityId: 'server-a' } }] });
        const { tree } = await renderScreen(
            <InboxContent
                model={{ ...model, workflowAttention: { ...model.workflowAttention, serverId: 'server-a' } }}
                onSelectItem={(focus) => selected.push(focus)}
            />,
        );

        tree.root.findByProps({ testID: 'inbox.stalled.stalled-worker' }).props.onPress();
        await tree.pressByTestIdAsync('inbox.run.library-run');
        tree.root.findByType('ApprovalInboxCard' as never).props.onPress();

        await vi.waitFor(() => expect(selected).toEqual([
            { kind: 'session', serverId: 'server-a', id: 'stalled-worker' },
            { kind: 'workflow_run', serverId: 'server-a', id: 'library-run' },
            { kind: 'approval', serverId: 'server-a', id: 'approval-1' },
        ]));
        expect(routerPush).not.toHaveBeenCalled();
    });

    it("keeps a stopped session's pending request in its row as the Resume card (stale request, A17)", async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} />);

        const other = tree.root.findByProps({ testID: 'inbox.group.other' });
        const cards = other.findAllByType('InboxSessionAttentionGroupCard');
        expect(cards.map((card) => card.props.session.id)).toEqual(['stopped']);
        expect(cards[0]?.props.permissionRequests).toEqual([{ id: 'p-stopped' }]);
        // Answer controls exist once per request: nowhere else in the Inbox.
        expect(tree.root.findAllByType('InboxSessionAttentionGroupCard')).toHaveLength(2);
    });

    it('shows a snoozed session quietly in place with its time and the row menu', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} />);

        const row = tree.root.findByProps({ testID: 'inbox.snoozed.snoozed' });
        expect(row.props.facts.join(' · ')).toContain('inbox.work.rows.snoozedUntil');
        expect(row.findAllByType('InboxSessionRowMenu')).toHaveLength(1);
        const other = tree.root.findByProps({ testID: 'inbox.group.other' });
        const keys = other.findAll((node) => typeof node.props.testID === 'string'
            && /^inbox\.(session|snoozed)\.[a-z-]+$/.test(String(node.props.testID)))
            .map((node) => String(node.props.testID));
        // Snoozed rows follow what still needs the person.
        expect(Array.from(new Set(keys))).toEqual(['inbox.session.failed', 'inbox.snoozed.snoozed']);
    });

    it('says once that the workflow input is stale while keeping the last-known rows', async () => {
        const { InboxContent } = await import('./InboxContent');
        const model = createModel({ workflowStale: true });
        const { tree } = await renderScreen(<InboxContent model={model} />);

        const line = tree.root.findByType('SurfaceFreshnessLine' as never);
        expect(line.props.asOf).toBe(NOW - 60_000);
        expect(line.props.action.onPress).toBe(model.workflowAttention.retry);
        expect(tree.root.findByProps({ testID: 'inbox.group.run:library-run' })).toBeTruthy();
    });

    it.each(['screen', 'popover'] as const)('shows unavailable with retry instead of empty on the %s', async (presentation) => {
        const { InboxContent } = await import('./InboxContent');
        const retry = vi.fn();
        const base = createModel({ needsYou: false });
        const model = { ...base, friendRequests: [],
            sessionPresentation: { ...base.sessionPresentation, readySessions: [], markAllReadTargets: [] },
            hasPrimaryAttention: false, showCaughtUp: false,
            workflowAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'failed' as const,
                refreshFailed: true, retry },
        };
        const { tree, pressByTestId } = await renderScreen(<InboxContent model={model} presentation={presentation} />);

        expect(tree.root.findAllByProps({ testID: 'inbox.empty' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'inbox.workflow_stale' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'inbox.workflow_unavailable' }).length).toBeGreaterThan(0);
        pressByTestId('inbox.workflow_retry');
        expect(retry).toHaveBeenCalledOnce();
    });

    it('keeps an empty stale workflow list truthful instead of adding a caught-up state', async () => {
        const { InboxContent } = await import('./InboxContent');
        const model = createModel({ needsYou: false, workflowStale: true });
        const { tree } = await renderScreen(<InboxContent model={model} />);
        expect(tree.root.findAllByProps({ testID: 'inbox.empty' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'inbox.workflow_unavailable' }).length).toBeGreaterThan(0);
    });

    it('keeps finished sessions and people in Updates, with mark-all as that section action', async () => {
        const { InboxContent } = await import('./InboxContent');
        const model = createModel();
        const { tree, pressByTestId } = await renderScreen(<InboxContent model={model} view="updates" />);

        expect(groupOrder(tree as never)).toEqual([]);
        expect(tree.root.findAllByType('InboxReadySessionRow')).toHaveLength(1);
        expect(tree.root.findAllByType('UserCard')).toHaveLength(1);
        pressByTestId('inbox.ready.mark_all_read');
        expect(model.markRead).toHaveBeenCalledWith(model.sessionPresentation.markAllReadTargets);
    });

    it('shows the calm empty Needs you state with no action when nothing waits on the person', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel({ needsYou: false })} />);

        // Updates still hold a finished session, so this is "Nothing needs you", not "all caught up".
        const empty = tree.root.findByType('EmptyState' as never);
        expect(empty.props.title).toBe('inbox.work.empty.title');
        expect(empty.props.layout).toBe('page');
        expect(empty.props.primaryAction).toBeUndefined();
    });

    it('keeps the popover flat: work roots inline, Other sessions and Updates as one line each', async () => {
        const { InboxContent } = await import('./InboxContent');
        const onOpenInbox = vi.fn();
        const { tree } = await renderScreen(
            <InboxContent model={createModel()} presentation="popover" onOpenInbox={onOpenInbox} />,
        );

        expect(tree.root.findAllByType('ItemGroup' as never)).toHaveLength(0);
        expect(groupOrder(tree as never)).toEqual(['inbox.group.lead:lead', 'inbox.group.run:library-run']);
        tree.root.findByProps({ testID: 'inbox.popover.more_other' }).props.onPress();
        expect(onOpenInbox).toHaveBeenCalledTimes(1);
        expect(tree.root.findAllByProps({ testID: 'inbox.popover.updates' }).length).toBeGreaterThan(0);
    });

    it('gives a popover row its title’s full width: kind and age on the line beneath and the answer inline (lab inbox-I2, phone-P4)', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} presentation="popover" onOpenInbox={vi.fn()} />);

        const runRow = tree.root.findByProps({ testID: 'inbox.run.library-run' });
        // Every row here needs the person: no state column and no state word compete with the title;
        // the line beneath says what it is and how long it has waited ("Workflow run · 8m").
        expect(runRow.findAllByProps({ testID: 'inbox.run.library-run.summary:state:label' })).toHaveLength(0);
        const facts = tree.findHostByTestId('inbox.run.library-run.summary:facts')!;
        expect(facts.props.numberOfLines).toBe(1);
        const textOf = (value: unknown): string => typeof value === 'string' ? value
            : Array.isArray(value) ? value.map(textOf).join('')
                : value && typeof value === 'object' && 'props' in value ? textOf((value as { props: { children?: unknown } }).props.children) : '';
        const line = textOf(facts.props.children);
        expect(line).toContain('inbox.work.rows.workflowRun');
        expect(line).not.toContain('workflows.runState');
        // The age rides at the end of that line, not in a trailing column.
        expect(facts.findAll((node) => typeof node.type === 'function' && node.type.name === 'InboxRelativeTime').length).toBeGreaterThan(0);
        expect(tree.root.findByProps({ testID: 'inbox.run.library-run.review' })).toBeTruthy();
    });

    it('names the step a held run waits on and its lane under the run (lab inbox-I1, DESIGN-15 R5)', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel({
            heldStep: { invocationId: 'inv-changelog', label: 'Write changelog', laneLabel: 'Changelog' },
        })} />);
        const facts = tree.findHostByTestId('inbox.run.library-run.summary:facts')!;
        const textOf = (value: unknown): string => typeof value === 'string' ? value
            : Array.isArray(value) ? value.map(textOf).join('')
                : value && typeof value === 'object' && 'props' in value ? textOf((value as { props: { children?: unknown } }).props.children) : '';
        const line = textOf(facts.props.children);
        expect(line).toContain('workflows.run.attentionWaitRow');
        expect(line).toContain('Changelog');
        // The line already says it waits for you; the state column does not say it again (DESIGN-16 D8).
        expect(tree.findHostByTestId('inbox.run.library-run.summary:state:label')).toBeNull();
    });

    it('opens a V2 approval through its portable owning Home rather than the focused Home', async () => {
        const { InboxContent } = await import('./InboxContent');
        const model = createModel({
            openApprovals: [{
                id: 'approval-home-b',
                header: { serverId: 'creator-local-b', serverIdentityId: 'stable-home-b' },
            }],
        });
        const { tree } = await renderScreen(<InboxContent model={model} />);

        tree.root.findByType('ApprovalInboxCard').props.onPress();

        expect(routerPush).toHaveBeenCalledWith('/inbox/approvals/approval-home-b?serverId=stable-home-b');
    });

    it("states each row's word and tone through the shared work-status owner (INT §5.3), never a local rule", async () => {
        const { InboxContent } = await import('./InboxContent');
        const { resolveWorkStatusTone } = await import('@/components/work/status/resolveWorkStatusTone');
        const { readSessionWorkStatusFacts } = await import('@/components/work/status/sessionWorkStatusFacts');
        const { workStatusWordStyle } = await import('@/components/work/status/workStatusTreatment');
        const { describeWorkflowRunState } = await import('@/components/workflows/presentation/workflowLifecyclePresentation');
        const { tree } = await renderScreen(<InboxContent model={createModel()} />);

        // A failed session: the Session owner's word, in the resolver's danger tone.
        const failedStatus = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(failed, NOW) });
        expect(failedStatus.tone).toBe('danger');
        const failedWord = tree.findHostByTestId('inbox.session.failed.summary:state:label')!;
        expect(failedWord.props.children).toBe(failedStatus.word);
        expect(NativeStyleSheet.flatten(failedWord.props.style).color).toBe(workStatusWordStyle('danger').color);
        expect(tree.findHostByTestId('inbox.session.failed.summary:facts')!.findAll((node) => node.props.children === failedStatus.word)).toHaveLength(0);

        // A run in the attention window: the run owner's word, in the attention tone (not a local "interrupted is error").
        // The row is titled by the run; its state is the row's one status, in the status column.
        const runRow = tree.root.findByProps({ testID: 'inbox.run.library-run' });
        expect(runRow.props.title).not.toBe(describeWorkflowRunState('interrupted').label);
        const runWord = tree.findHostByTestId('inbox.run.library-run.summary:state:label')!;
        expect(runWord.props.children).toBe(describeWorkflowRunState('interrupted').label);
        expect(NativeStyleSheet.flatten(runWord.props.style).color).toBe(workStatusWordStyle('attention').color);
        // A run that is its own work root does not repeat its name above its row; its sheet is headed by
        // the kind, like its sibling groups (DESIGN-17 R4).
        const runGroup = tree.root.findByProps({ testID: 'inbox.group.run:library-run' }).findAllByType('ItemGroup' as never)[0];
        expect(runGroup?.props.title).toBe('inbox.work.groups.runsTitle');

        // A stalled worker: its Session word beside the row's own explanation.
        const stalledStatus = resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(stalledWorker, NOW) });
        const stalledWord = tree.findHostByTestId('inbox.stalled.stalled-worker.summary:state:label')!;
        expect(stalledWord.props.children).toBe(stalledStatus.word);
        expect(NativeStyleSheet.flatten(stalledWord.props.style).color).toBe(workStatusWordStyle(stalledStatus.tone).color);
    });

    it('states a finished session in Updates with its own word, healthy and neutral', async () => {
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} view="updates" />);

        const row = tree.root.findByType('InboxReadySessionRow' as never);
        // The Session owner's word replaces the Inbox-local "Ready for review" status.
        expect(row.props.statusTone).toBe('neutral');
        expect(typeof row.props.statusWord).toBe('string');
        expect(String(row.props.subtitle)).not.toContain('status.readyForReview');
    });

    it('removes the leading slot when the canonical Session-list identity preference is none', async () => {
        identityState.display = 'none';
        const { InboxContent } = await import('./InboxContent');
        const { tree } = await renderScreen(<InboxContent model={createModel()} />);

        const failedRow = tree.root.findByProps({ testID: 'inbox.session.failed' });
        // A failed session keeps its failure glyph; identity marks follow the preference.
        expect(failedRow.findAllByType('SessionListIdentity')).toHaveLength(0);
    });
});
