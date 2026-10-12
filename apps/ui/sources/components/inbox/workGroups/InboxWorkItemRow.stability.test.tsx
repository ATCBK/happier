import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { buildInboxWorkGroups, type InboxWorkItem } from '@/activity/presentation/buildInboxWorkGroups';

const paints = vi.hoisted(() => new Map<string, number>());
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default },
        Linking: { openURL: openUrl }, View: ({ children, ...props }: React.PropsWithChildren<{ testID?: string }>) => {
        if (props.testID?.endsWith('.summary')) paints.set(props.testID, (paints.get(props.testID) ?? 0) + 1);
        return React.createElement('View', props, children);
    } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, options) => key === 'workflows.run.attentionWaitRow' ? `${options?.step} is waiting for you`
        : key === 'workflows.run.attentionWaitRowMore' ? `${options?.step} and ${options?.count} more wait for you` : key });
});
const { InboxWorkItemRow } = await import('./InboxWorkItemRow');

describe('Inbox Work row stability', () => {
    it('opens the canonical PR URL as the Landing primary action even in a list-detail Inbox', async () => {
        const session = createSessionFixture({ id: 'landing', serverId: 'home' });
        const navigate = vi.fn();
        const onSelectItem = vi.fn();
        const item = { kind: 'landing', key: 'landing:landing', session,
            link: { sessionId: session.id, serverId: 'home', number: 42, url: 'https://github.com/acme/widgets/pull/42', state: 'open', observedAt: 100 } } as const;
        const screen = await renderScreen(<InboxWorkItemRow item={item} spansHomes={false} workflowServerId="home" identityDisplay="none"
            presentation="screen" navigate={navigate} onSelectItem={onSelectItem} settle={vi.fn(async () => {})} setReminder={vi.fn(async () => {})} />);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('files.sourceControl.pullRequests.states.open');
        await act(async () => { screen.findHostByTestId('inbox.landing.landing')!.props.onPress(); });
        expect(openUrl).toHaveBeenCalledWith(item.link.url);
        expect(navigate).not.toHaveBeenCalled();
        expect(onSelectItem).not.toHaveBeenCalled();
    });
    it('renders the held-step names from the Run summary through the real Inbox projection and row', async () => {
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'held', state: 'waiting_for_review', attentionRequired: true,
            heldStep: { invocationId: 'review', label: 'Review the changelog', laneLabel: 'Changelog' } }), null);
        const groups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
            openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
        const item = groups.flatMap(group => group.items)[0];
        if (!item) throw new Error('held_item_missing');
        const screen = await renderScreen(<InboxWorkItemRow item={item} spansHomes={false} workflowServerId="home" identityDisplay="none"
            presentation="screen" navigate={vi.fn()} settle={vi.fn(async () => {})} setReminder={vi.fn(async () => {})} />);
        const content = JSON.stringify(screen.tree.toJSON());
        expect(content).toContain('Review the changelog is waiting for you');
        expect(content).toContain('Changelog');
    });
    it('names the first of several holds and how many more wait (DESIGN-17 R4)', async () => {
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'held5', state: 'waiting_for_review', attentionRequired: true,
            heldCount: 5, heldStep: { invocationId: 'review', label: 'Review the changelog draft' } }), null);
        const groups = buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
            openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null });
        const item = groups.flatMap(group => group.items)[0];
        if (!item) throw new Error('held_item_missing');
        const screen = await renderScreen(<InboxWorkItemRow item={item} spansHomes={false} workflowServerId="home" identityDisplay="none"
            presentation="screen" navigate={vi.fn()} settle={vi.fn(async () => {})} setReminder={vi.fn(async () => {})} />);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Review the changelog draft and 4 more wait for you');
    });
    it('does not repaint an unchanged real row when another Inbox run updates', async () => {
        const run = (id: string, updatedAt: string) => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id, state: 'interrupted', updatedAt }), null);
        const a = run('a', '2026-09-30T11:00:00.000Z');
        const b = run('b', '2026-09-30T11:00:00.000Z');
        const input = { sessionEntries: [], workflowRuns: [a, b], automationRuns: [], automationServerId: null,
            openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null };
        const first = buildInboxWorkGroups(input);
        const actions = { navigate: vi.fn(), settle: vi.fn(async () => {}), setReminder: vi.fn(async () => {}) };
        const draw = (items: readonly InboxWorkItem[]) => <>{items.map((item) => <InboxWorkItemRow key={item.key} item={item}
            spansHomes={false} workflowServerId="home" identityDisplay="none" presentation="screen" {...actions} />)}</>;
        const screen = await renderScreen(draw(first.flatMap((group) => group.items)));
        expect(screen.findHostByTestId('inbox.run.a.summary')).not.toBeNull();
        expect(screen.findHostByTestId('inbox.run.b.summary')).not.toBeNull();
        const before = paints.get('inbox.run.a.summary');
        const changedBefore = paints.get('inbox.run.b.summary') ?? 0;
        expect(before).toBeGreaterThan(0);
        const next = buildInboxWorkGroups({ ...input, workflowRuns: [a, run('b', '2026-09-30T11:05:00.000Z')] }, first);
        await act(async () => screen.tree.update(draw(next.flatMap((group) => group.items))));
        expect(paints.get('inbox.run.a.summary')).toBe(before);
        expect(paints.get('inbox.run.b.summary')).toBeGreaterThan(changedBefore);
    });
});
