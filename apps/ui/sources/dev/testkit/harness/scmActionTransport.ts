import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ScmComparisonCaptureInputSchema, ScmDiffSummaryGenerateInputSchema } from '@happier-dev/protocol/scm';
import { createScmReviewedMarksOperations } from '@/sync/ops/scmDiffSummary/reviewedMarks';
import { createScmDiffSummaryOperations, type ScmDiffSummaryGenerateRpc, type ScmComparisonCaptureRpc } from '@/sync/ops/scmDiffSummary/generate';
import {
    createScmDiffSummaryResultOperations,
    type ScmDiffSummaryResultRpc,
} from '@/sync/ops/scmDiffSummary/results';

/** Keep Action policy, schemas and result normalization real above the Machine RPC boundary. */
export function createScmDiffSummaryResultOperationsWithTransport(
    params: Parameters<typeof createScmDiffSummaryResultOperations>[0] & Readonly<{ rpc?: ScmDiffSummaryResultRpc }>,
) {
    const { rpc, ...captured } = params;
    const actionExecutor = captured.actionExecutor ?? (rpc ? createActionExecutor(createActionExecutorBoundaryFixture({
        isActionApprovalRequired: () => false,
        scmActionExecute: ({ actionId, input, context }) => {
            const method = getActionSpec(actionId).bindings?.rpcMethod;
            if (!method) throw new Error(`Missing SCM transport for ${actionId}`);
            // The real Action owner has validated this saved-result request before transport.
            return rpc(method, input as Readonly<{ cwd: string }>, { signal: context.signal });
        },
    // Unrelated transports are intentionally absent from this boundary fixture.
    })) : undefined);
    return createScmDiffSummaryResultOperations({ ...captured, ...(actionExecutor ? { actionExecutor } : {}) });
}

/** Generator/capture network replies remain below real Action schema and policy admission. */
export function createScmDiffSummaryOperationsWithTransport(
    params: Parameters<typeof createScmDiffSummaryOperations>[0] & Readonly<{
        generateSummary?: ScmDiffSummaryGenerateRpc; captureComparison?: ScmComparisonCaptureRpc;
    }> = {},
) {
    const { generateSummary, captureComparison, ...captured } = params;
    const actionExecutor = captured.actionExecutor ?? ((generateSummary || captureComparison) ? createActionExecutor(createActionExecutorBoundaryFixture({
        isActionApprovalRequired: () => false,
        scmActionExecute: ({ actionId, input, context }) => {
            const accountId = context.runtimeAccountId ?? context.expectedAccountId;
            const options = { ...(accountId && context.serverId ? { scope: { serverId: context.serverId, accountId } }
                : context.serverId ? { serverId: context.serverId.trim() } : {}),
                ...(context.signal ? { signal: context.signal } : {}) };
            const sessionId = context.externalActionTarget?.kind === 'session'
                ? context.externalActionTarget.sessionId : context.defaultSessionId ?? '';
            if (actionId === 'scm.diffSummary.generate' && generateSummary)
                return generateSummary(sessionId, ScmDiffSummaryGenerateInputSchema.parse(input), options);
            if (actionId === 'scm.diffSummary.capture' && captureComparison)
                return captureComparison(sessionId, ScmComparisonCaptureInputSchema.parse(input), options);
            throw new Error(`Unexpected SCM transport for ${actionId}`);
        },
    // These suites own generator/capture boundaries, not unrelated Action transports.
    })) : undefined);
    return createScmDiffSummaryOperations({ ...captured, ...(actionExecutor ? { actionExecutor } : {}) });
}

/** Personal UI marks use the real Account CAS/encryption owner without a Machine dependency. */
export function createScmReviewedMarksOperationsWithTransport(params: Parameters<typeof createScmReviewedMarksOperations>[0]) {
    return createScmReviewedMarksOperations(params);
}
