import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelNonRnModuleMocks } from './sessionDetailsPanelNonRnModuleMocks';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
import { createSessionScmReviewDetailsTab } from './details/sessionDetailsTabBuilders';

// Hoisted independently of helper options: the statically imported render
// testkit can request React Native before those options have been installed.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
installSessionDetailsPanelNonRnModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();
// Resolve cold module loading during collection, not inside a lifecycle case's
// budget. Both the Account harness and the pane then use these same real owners.
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
const { SessionScmReviewDetailsView } = await import('@/components/sessions/files/views/SessionScmReviewDetailsView');

describe('SessionDetailsPanel (scm review resource)', () => {
    it('renders the current review resource through the scoped Session', async () => {
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' }));
        const views = screen.tree.findAllByType(SessionScmReviewDetailsView);
        expect(views).toHaveLength(1);
        expect(views[0].props).toMatchObject({ sessionId: 's1', serverId: runtime.serverId });
    });

    it('retains the review target on unrelated panel updates and replaces it when navigation changes', async () => {
        const panel = (presentation: 'screen' | 'pane') => <runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" presentation={presentation} />
        </runtime.Wrapper>;
        const screen = await renderScreen(panel('pane'));
        await act(async () => runtime.pane.openDetailsTab(createSessionScmReviewDetailsTab({
            comparison: { kind: 'workingTree', comparisonId: 'captured-a' }, view: 'walkthrough', explain: true,
        }), { intent: 'pinned' }));
        const target = screen.tree.findAllByType(SessionScmReviewDetailsView)[0]!.props.target;

        await screen.update(panel('screen'));
        // This target feeds callbacks all the way down to every memoized hunk card.
        expect(screen.tree.findAllByType(SessionScmReviewDetailsView)[0]!.props.target).toBe(target);

        await act(async () => runtime.pane.openDetailsTab(createSessionScmReviewDetailsTab({
            comparison: { kind: 'commit', commit: 'abc123', comparisonId: 'captured-b' }, view: 'files', explain: false,
        }), { intent: 'pinned' }));
        const next = screen.tree.findAllByType(SessionScmReviewDetailsView)[0]!.props.target;
        expect(next).not.toBe(target);
        expect(next).toEqual({ comparison: { kind: 'commit', commit: 'abc123', comparisonId: 'captured-b' }, view: 'files', explain: false });
    });

    it('places the dedicated screen close action before the tab strip on native', async () => {
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" presentation="screen" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' }));
        const root = screen.findHostByTestId('session-details-panel-root');
        expect(root).not.toBeNull();
        const close = screen.findHostByTestId('session-details-close');
        const tab = screen.findHostByTestId('session-details-tab-scmReview_working');
        expect(close).not.toBeNull();
        expect(tab).not.toBeNull();
        expect(root?.findAll((node) => typeof node.type === 'string'
            && ['session-details-close', 'session-details-tab-scmReview_working'].includes(node.props.testID))
            .map((node) => node.props.testID)).toEqual(['session-details-close', 'session-details-tab-scmReview_working']);
        await act(async () => close?.props.onPress());
        expect(runtime.pane.scopeState?.details.isOpen).toBe(false);
    });
});
