import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ScmComparisonCaptureInputSchema, ScmComparisonCaptureOutputSchema, ScmComparisonSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createMachineFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { storage } from '@/sync/domains/state/storageStore';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/components/ui/popover', async importOriginal =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));
installSessionDetailsPanelCommonModuleMocks();

const TURN_COMPARISON_ID = 'a'.repeat(64);
const SESSION_COMPARISON_ID = 'b'.repeat(64);
const runtime = installSessionPaneRuntimeTestHarness({ rpc: async (method, input) => {
    if (method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) {
        const request = ScmComparisonCaptureInputSchema.parse(input);
        const comparison = ScmComparisonSchema.parse({ id: request.comparisonId ?? SESSION_COMPARISON_ID, source: request.source,
            repository: { rootPath: '/Users/tester/project' }, endpoints: { before: 'before', after: 'after' },
            inventory: { state: 'complete', files: [], reasons: [] } });
        return ScmComparisonCaptureOutputSchema.parse({ success: true, comparison,
            metadata: { sourceKey: comparison.id, source: comparison.source } });
    }
    throw new Error(`Unexpected RPC ${method}`);
} });

// The Socket boundary is installed above. Transform the real lazy SCM surface
// during collection so cold compilation does not consume the navigation deadline.
const { SessionDetailsDestinationBody } = await import('./SessionDetailsDestinationBody');
const { SessionCapturedScmReviewDetailsView } = await import('@/components/sessions/files/views/SessionCapturedScmReviewDetailsView');
await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
const { parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');

describe('hosted comparison navigation', () => {
    it('selects This session through the real scope menu and updates the scmReview destination', async () => {
        storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'classic' });
        const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now() });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [runtime.serverId]: [machine] } });
        const navigated: string[] = [];
        function Destination() {
            const [params, setParams] = React.useState<Record<string, string>>({ id: 's1', serverId: runtime.serverId,
                details: 'scmReview', comparison: 'turnCheckpoint', turnId: 'turn-1', comparisonId: TURN_COMPARISON_ID, view: 'files' });
            const open = (href: unknown) => {
                if (typeof href !== 'string') throw new Error('Expected serialized comparison destination');
                navigated.push(href);
                setParams({ id: 's1', ...Object.fromEntries(new URL(href, 'https://happier.test').searchParams) });
            };
            return <DestinationInstanceHost tabId="comparison-destination" ref={{ kind: 'sessionDetails', params }}
                pathname="/session/s1/details" focused visible navigation={{ push: open, replace: open, back: () => {} }}>
                <SessionDetailsDestinationBody />
            </DestinationInstanceHost>;
        }
        const screen = await renderScreen(<runtime.Wrapper><Destination /></runtime.Wrapper>);
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId('captured-comparison-files'), screen.getTextContent()).not.toBeNull();
        });
        await screen.pressByTestIdAsync('scm-comparison-scope');
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(screen.findHostByTestId('dropdown-option-session')).not.toBeNull();
        });
        await screen.pressByTestIdAsync('dropdown-option-session');
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(navigated).not.toEqual([]);
        });
        const params = Object.fromEntries(new URL(navigated.at(-1)!, 'https://happier.test').searchParams);
        expect(parseSessionPaneUrlState(params)?.details).toMatchObject({ kind: 'scmReview', comparison: { kind: 'session' }, view: 'files' });
        expect(screen.tree.findByType(SessionCapturedScmReviewDetailsView).props.comparison.kind).toBe('session');
    });
});
