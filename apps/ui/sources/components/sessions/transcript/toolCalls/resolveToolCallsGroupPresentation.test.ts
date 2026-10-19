import { describe, expect, it } from 'vitest';
import { resolveToolCallsGroupPresentation, resolveToolCallsGroupStatus, shouldShowToolCallsGroupStatusIndicator } from './resolveToolCallsGroupPresentation';
import { createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';

describe('hidden tool group presentation', () => {
    it('settles a published review group while preserving other running tool activity', () => {
        const ordinary = createToolCallMessageFixture({ id: 'ordinary' });
        const review = createToolCallMessageFixture({ id: 'review', tool: { ...ordinary.tool, id: 'review-call',
            name: 'SubAgentRun', input: { intent: 'review', runId: 'review-run' } }, children: [{
            kind: 'agent-text', id: 'findings', localId: null, createdAt: 2, text: 'Reviewed.',
            meta: { happier: { kind: 'review_findings.v2', payload: ReviewFindingsV2Schema.parse({
                runRef: { runId: 'review-run', callId: 'review-call', backendId: 'claude' },
                reviewOutcome: 'complete', summary: 'Reviewed.', overviewMarkdown: 'Overview.', findings: [], generatedAtMs: 2,
            }) } },
        }] });

        expect(resolveToolCallsGroupStatus({ toolMessages: [review] })).toBe('completed');
        expect(resolveToolCallsGroupStatus({ toolMessages: [review, ordinary] })).toBe('running');
        expect(review.tool.state).toBe('running');
    });

    it('retains an error or denied recovery indication while ordinary tool activity continues', () => {
        const running = createToolCallMessageFixture({ id: 'running' });
        const error = createToolCallMessageFixture({ id: 'error', tool: { ...running.tool, state: 'error' } });
        const denied = createToolCallMessageFixture({ id: 'denied', tool: { ...running.tool,
            permission: { id: 'approval', status: 'denied' } } });
        expect(resolveToolCallsGroupStatus({ toolMessages: [running, error], showToolCalls: false })).toBe('error');
        expect(resolveToolCallsGroupStatus({ toolMessages: [running, denied], showToolCalls: false })).toBe('permission_denied');
        expect(resolveToolCallsGroupStatus({ toolMessages: [running, error], showToolCalls: true })).toBe('running');
    });
    it('keeps the collapsed group header-only but reveals every tool after explicit disclosure', () => {
        const input = { showToolCalls: false, toolCalls: [1, 2], collapsedPreviewCount: 3 };
        expect(resolveToolCallsGroupPresentation({ ...input, expanded: false })).toMatchObject({
            visibleToolCalls: [], hiddenCount: 2, showBody: false, showExpandMore: false,
        });
        expect(resolveToolCallsGroupPresentation({ ...input, expanded: true })).toMatchObject({
            visibleToolCalls: [1, 2], hiddenCount: 0, showBody: true, showExpandMore: false,
        });
    });
    it('suppresses ordinary tool activity while retaining error and denied recovery indications', () => {
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'running' })).toBe(false);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'completed' })).toBe(false);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'error' })).toBe(true);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: false, status: 'permission_denied' })).toBe(true);
        expect(shouldShowToolCallsGroupStatusIndicator({ showToolCalls: true, status: 'running' })).toBe(true);
    });
});
