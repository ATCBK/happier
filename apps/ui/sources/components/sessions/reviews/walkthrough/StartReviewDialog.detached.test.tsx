import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { ExecutionRunGetResponseSchema, ReviewFindingsV2Schema } from '@happier-dev/protocol';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ReviewWalkthroughResponseSchema } from '@happier-dev/protocol/reviews/reviewNarration';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
await prepareSessionFilesViewTestkit();
const { StartReviewDialog } = await import('./StartReviewDialog');
const { requestFinishedReviewWalkthrough, requestExplainReviewFindings } = await import('@/sync/ops/reviews/reviewWalkthrough');
const { useWalkthroughReview } = await import('./useWalkthroughReview');
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
afterEach(async () => { standardCleanup(); await fixture?.dispose(); });

const comparison = ScmComparisonSchema.parse({ id: 'detached-comparison', source: { kind: 'workingTree' },
    repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } });

async function setup() {
    fixture = await createSessionFilesViewFixture({ rootPath: '/repo', rpc: request => {
        if (request.method === 'capabilities.detect') return { protocolVersion: 1, results: { 'tool.executionRuns': {
            ok: true, checkedAt: 1, data: { protocolVersion: 2, backends: { claude: { available: true, intents: ['review'] } },
                features: { detachedScope: true, startAndWait: true, runScopedAgentBindings: true, secretReferenceOverlay: true } } } } };
        if (request.method === 'execution.run.action') {
            const input = request.payload as { actionId: string };
            return input.actionId === 'review.walkthrough'
                ? { ok: true, result: ReviewWalkthroughResponseSchema.parse({ runId: 'narrator-1', callId: 'call-1', sidechainId: 'call-1',
                    mode: 'seeded_narrator', state: 'collecting', comparisonId: comparison.id, comparison, reviewRunIds: ['review-1'] }) }
                : { ok: true, result: { refinement: { actionId: 'scm.diffSummary.refine', input: { cwd: '/repo', resultId: 'result-1',
                    expectedRevision: 2, output: 'walkthrough', stopIds: ['stop-1'], instructions: 'Explain the finding.' } } } };
        }
        if (request.method === 'execution.run.get') return ExecutionRunGetResponseSchema.parse({
            run: { runId: 'review-1', callId: 'call-1', sidechainId: 'call-1', intent: 'review',
                backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only', retentionPolicy: 'resumable',
                runClass: 'long_lived', ioMode: 'streaming', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 },
            structuredMeta: { kind: 'scm_diff_summary.v1', payload: {} },
            reviewFindings: ReviewFindingsV2Schema.parse({ runRef: { runId: 'review-1', callId: 'call-1', backendId: 'claude' },
                comparisonId: comparison.id, reviewOutcome: 'complete', summary: 'Original findings', overviewMarkdown: 'Original findings', generatedAtMs: 2,
                findings: [{ id: 'finding-1', title: 'Reachable defect', severity: 'high', category: 'correctness', summary: 'Check the condition.' }] }),
        });
        if (request.method === 'scm.diffSummary.refine') return { success: false, errorCode: 'revision_conflict', error: 'Saved result changed', latestRevision: 3 };
        return undefined;
    }, request: async url => new URL(String(url)).pathname === ACP_CATALOG_ROWS_ROUTE_V1
        ? Response.json(AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } } }))
        : Response.json({}, { status: 404 }),
    });
    fixture.storage.setState({ sessions: {} });
}

describe('detached review walkthrough', () => {
    it('reads original findings through the workspace Run even after narration replaces its current structured output', async () => {
        await setup();
        const hook = await renderHook(() => useWalkthroughReview({ host: { machineId: 'm1' }, cwd: '/repo',
            scope: { serverId: fixture.home.id, accountId: 'alice' }, comparison, walkthrough: null,
            producer: { kind: 'review', reviewedRuns: [{ runId: 'review-1', callId: 'call-1', backendId: 'claude',
                status: 'succeeded', hasOutput: true, comparisonId: comparison.id }] } }));
        await vi.waitFor(() => expect(hook.getCurrent()?.overlay.tail.map(finding => finding.findingId)).toEqual(['finding-1']));
        expect(hook.getCurrent()?.overlay.summary.state).toBe('complete');
        expect(fixture.requests.filter(request => request.method === 'execution.run.get')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ runId: 'review-1', includeStructured: true }) }),
        ]);
        expect(fixture.requests.some(request => request.targetId === 's1' || request.method === 'review.comments.list')).toBe(false);
    });
    it.each([false, true])('keeps the admitted workspace walkthrough toggle usable with default %s', async defaultWalkthrough => {
        await setup();
        const screen = await fixture.render(<StartReviewDialog machineId="m1" serverId={fixture.home.id} cwd="/repo"
            comparison={{ kind: 'workingTree' }} comparisonId={comparison.id} scopeLabel="Pending changes"
            defaultWalkthrough={defaultWalkthrough} onClose={vi.fn()} onStarted={vi.fn()} />);
        await flushHookEffects({ cycles: 10 });
        expect(screen.findByTestId('start-review-walkthrough')?.props.disabled).toBe(false);
        expect(screen.findByTestId('start-review-walkthrough')?.props.accessibilityState?.checked).toBe(defaultWalkthrough);
        await screen.pressByTestIdAsync('start-review-walkthrough');
        expect(screen.findByTestId('start-review-walkthrough')?.props.accessibilityState?.checked).toBe(!defaultWalkthrough);
        expect(fixture.requests.some(request => request.method === 'execution.run.start')).toBe(false);
    });
    it('requests finished narration and targeted explanation on the original Machine and propagates a saved revision conflict', async () => {
        await setup();
        const target = { sessionId: null, machineId: 'm1', serverId: fixture.home.id, cwd: '/repo', runId: 'review-1', reviewRunIds: ['review-1'] };
        expect(await requestFinishedReviewWalkthrough({ ...target, comparisonId: comparison.id, fallbackComparison: { kind: 'workingTree' } }))
            .toMatchObject({ ok: true, comparisonId: comparison.id });
        expect(await requestExplainReviewFindings({ ...target, resultId: 'result-1', expectedRevision: 2,
            findingIds: [{ runId: 'review-1', findingId: 'finding-1' }] })).toMatchObject({ ok: false, errorCode: 'revision_conflict' });
        expect(fixture.requests.filter(request => request.method === 'execution.run.action')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ runId: 'review-1', actionId: 'review.walkthrough' }) }),
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ runId: 'review-1', actionId: 'review.explain_findings',
                input: expect.objectContaining({ cwd: '/repo', expectedRevision: 2 }) }) }),
        ]);
        expect(fixture.requests.filter(request => request.method === 'scm.diffSummary.refine')).toEqual([
            expect.objectContaining({ targetId: 'm1', payload: expect.objectContaining({ cwd: '/repo', expectedRevision: 2 }) }),
        ]);
        expect(fixture.requests.some(request => request.targetId === 's1')).toBe(false);
    });
});
