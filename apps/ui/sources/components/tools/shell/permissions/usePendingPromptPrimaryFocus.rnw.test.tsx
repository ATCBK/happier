/** @vitest-environment jsdom */
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, createTestSessionTranscriptSource, makeToolCall, makeToolViewProps, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// Exercise the actual web host's focusability and ref attachment, not a focus spy.
vi.mock('react-native', () => vi.importActual<typeof import('react-native-web')>('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { AskUserQuestionView } = await import('@/components/tools/renderers/workflow/AskUserQuestionView');
const { ToolView } = await import('@/components/tools/shell/views/ToolView');
const { ToolTimelineRow } = await import('@/components/tools/shell/views/ToolTimelineRow');
const { PermissionFooter } = await import('./PermissionFooter');
const { ApprovalDecisionFooter } = await import('@/components/tools/shell/approvals/ApprovalDecisionFooter');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { setPendingNavigationLanding, clearPendingNavigationState } = await import('@/activity/source/pendingNavigationRuntime');

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
    if (root) await React.act(async () => root!.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    clearPendingNavigationState();
    await homes.reset();
});

describe('Next answer focus through React Native Web', () => {
    it.each([
        { kind: 'choice', placement: 'prompt' },
        { kind: 'choice', placement: 'card' },
        { kind: 'choice', placement: 'timeline' },
        { kind: 'text', placement: 'prompt' },
        { kind: 'permission', placement: 'prompt' },
        { kind: 'action', placement: 'prompt' },
    ] as const)('focuses the $kind answer in the $placement after hydration without answering', async ({ kind, placement }) => {
        const address = { serverId: 'home-a', sessionId: 's1' };
        const requestId = 'question-1';
        const input = kind === 'text'
            ? { questions: [{ id: 'answer', question: 'Describe your choice', selection: 'text', required: true }] }
            : { questions: [{ question: 'Do you prefer River or Meadow?', header: 'Claude question',
                options: [{ label: 'River', description: 'I prefer River' }, { label: 'Meadow', description: 'I prefer Meadow' }], multiSelect: false }] };
        const tool = makeToolCall({ name: 'AskUserQuestion', state: 'running', input,
            permission: { id: requestId, status: 'pending' } });
        const answerUserAction = vi.fn();
        const respondToPermission = vi.fn();
        const metadata = { ...createSessionFixture().metadata!, flavor: 'claude' };
        const source = createTestSessionTranscriptSource({ ...address,
            metadata,
            interaction: { canSendMessages: true, canApprovePermissions: true },
            agentState: { requests: { [requestId]: { tool: 'AskUserQuestion', kind: 'user_action', arguments: input, createdAt: 1 } } },
            actions: { answerUserAction, respondToPermission, abort: async () => {}, submitMessage: async () => {} },
        });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        setPendingNavigationLanding(address, requestId, 'pending', placement === 'prompt' ? 'prompt' : 'transcript');
        const Row = placement === 'timeline' ? ToolTimelineRow : ToolView;
        let suspended = false;
        let resume: () => void = () => {};
        const pending = new Promise<void>((resolve) => { resume = resolve; });
        function HydrationBoundary() {
            if (suspended) throw pending;
            return null;
        }
        const renderAnswer = () => kind === 'action'
            ? <ApprovalDecisionFooter requestId={requestId} testIDPrefix="action-confirmation" isDeciding={false}
                onApprove={respondToPermission} onReject={respondToPermission} />
            : kind === 'permission'
                ? <PermissionFooter permission={{ id: requestId, status: 'pending' }} sessionId={address.sessionId}
                    toolName="Read" toolInput={{ file_path: '/tmp/note.txt' }} metadata={metadata} canApprovePermissions />
                : placement === 'prompt' ? <AskUserQuestionView {...makeToolViewProps(tool, { sessionId: address.sessionId })} />
                    : <Row tool={tool} metadata={null} sessionId={address.sessionId} messageId="message-1"
                        displaySettings={{
                            toolViewDetailLevelDefault: 'title',
                            toolViewDetailLevelDefaultLocalControl: settingsDefaults.toolViewDetailLevelDefaultLocalControl,
                            toolViewDetailLevelByToolName: {}, toolViewExpandedDetailLevelDefault: 'summary',
                            toolViewExpandedDetailLevelByToolName: {}, toolViewTapAction: 'expand',
                            permissionPromptSurface: 'composer', toolViewTimelineFeedDefaultExpanded: false,
                        }} />;
        const tree = () => wrapWithSessionTranscriptSource(<React.Suspense fallback={<div data-testid="hydrating" />}><AppPaneProvider>
            {renderAnswer()}
            <HydrationBoundary />
        </AppPaneProvider></React.Suspense>, source);
        await React.act(async () => root!.render(tree()));
        const testID = kind === 'text' ? 'ask-user-question.freeform:0' : kind === 'permission' ? 'permission-footer.allow'
            : kind === 'action' ? 'action-confirmation-approve' : 'ask-user-question.option:0:0';
        const first = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
        expect(first).not.toBeNull();
        expect(document.activeElement).toBe(first);
        expect(first?.getAttribute('aria-checked')).not.toBe('true');
        expect(answerUserAction).not.toHaveBeenCalled();
        expect(respondToPermission).not.toHaveBeenCalled();
        // An ordinary update with the same mounted answer must not recapture
        // focus after the person deliberately moves elsewhere.
        container.tabIndex = -1;
        container.focus();
        await React.act(async () => root!.render(tree()));
        expect(document.activeElement).toBe(container);
        first!.focus();
        // A cold destination can suspend after the answer first mounts. React
        // retains the component but detaches its ref until that content returns.
        suspended = true;
        await React.act(async () => root!.render(tree()));
        expect(container.querySelector('[data-testid="hydrating"]')).not.toBeNull();
        first!.blur();
        expect(document.activeElement).toBe(document.body);
        suspended = false;
        await React.act(async () => { resume(); root!.render(tree()); });
        expect(container.querySelector('[data-testid="hydrating"]')).toBeNull();
        expect(document.activeElement).toBe(first);
        expect(first?.getAttribute('aria-checked')).not.toBe('true');
        expect(answerUserAction).not.toHaveBeenCalled();
        expect(respondToPermission).not.toHaveBeenCalled();
    });
});
