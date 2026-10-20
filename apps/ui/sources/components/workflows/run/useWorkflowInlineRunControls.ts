import * as React from 'react';
import type { WorkflowRunAcceptedContextV1, WorkflowRunStartResultV1 } from '@happier-dev/protocol/workflows/actionsV1';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { prepareWorkflowRunStartV1 } from '@happier-dev/protocol/workflows';
import { canStartWorkflowAnotherRound, describeWorkflowRunState } from '../presentation/workflowLifecyclePresentation';
import { describeWorkflowRunProgress } from '../presentation/workflowRunProgress';
import { createWorkflowRunDetailActions } from '@/sync/domains/workflows/workflowRunDetailActions';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useWorkflowRunNowController } from './useWorkflowRunNowController';
import { projectAcceptedWorkflowRunTarget } from './projectAcceptedWorkflowRunTarget';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';

/** Managed summary and existing controls; native Workflow activity is a distinct producer. */
export function useWorkflowInlineRunControls(params: Readonly<{
    run: WorkflowRunSummaryV1;
    definition: WorkflowDefinitionV1 | null;
    acceptedContext: WorkflowRunAcceptedContextV1 | null;
    /** Private authored fact from the opened list owner; never inferred from a title or pattern id. */
    supportsAnotherRound?: boolean;
    accountLifetime: ServerAccountScopeLifetime;
    canEdit: boolean;
    cancelRequested?: boolean;
    onStarted: (result: WorkflowRunStartResultV1) => void;
}>) {
    const { run, definition, acceptedContext, accountLifetime, canEdit, cancelRequested, supportsAnotherRound } = params;
    const actions = React.useMemo(() => createWorkflowRunDetailActions({ accountLifetime }), [accountLifetime]);
    const start = useWorkflowRunNowController(accountLifetime);
    const mounted = useMountedRef();
    const onStartedRef = React.useRef(params.onStarted);
    onStartedRef.current = params.onStarted;
    const anotherRound = React.useCallback(async () => {
        if (!accountLifetime.isCurrent() || !canStartWorkflowAnotherRound({ run, definition, canEdit, cancelRequested,
            supportsAnotherRound, hasAcceptedContext: acceptedContext !== null || supportsAnotherRound === true })) return;
        const admitted = await start.runNow({
            prepareRequest: async () => {
                // Pressing Another round is deliberate detail demand. Reloaded timelines never open
                // full invocation history merely to decide whether to draw this action.
                const detail = definition && acceptedContext ? { run, definition, acceptedContext } : await actions.getRun(run.id);
                if (!accountLifetime.isCurrent() || !canStartWorkflowAnotherRound({ run: detail.run,
                    definition: detail.definition, canEdit, cancelRequested, hasAcceptedContext: true })) {
                    throw new WorkflowActionError({ message: 'invalid_input', rawCode: 'invalid_input' });
                }
                const prepared = prepareWorkflowRunStartV1({ definition: detail.definition, acceptedContext: detail.acceptedContext,
                    replay: { runId: run.id, intent: 'another_round' } });
                return { ...prepared, ...(prepared.project ? { project: projectAcceptedWorkflowRunTarget(prepared.project) } : {}) };
            }, refusal: 'inline',
            isInvocationCurrent: () => mounted.current && accountLifetime.isCurrent() });
        if (admitted && mounted.current && accountLifetime.isCurrent()) onStartedRef.current(admitted);
    }, [acceptedContext, accountLifetime, actions, canEdit, cancelRequested, definition, mounted, run, start, supportsAnotherRound]);
    return {
        lifecycle: describeWorkflowRunState(params.run.state, { workflowCustodyState: params.run.workflowCustodyState,
            cancelRequested: params.cancelRequested, inAttentionWindow: params.run.attentionRequired }),
        progress: describeWorkflowRunProgress(params.run.stepProgress),
        availability: params.run.availability,
        actions,
        anotherRound: canStartWorkflowAnotherRound({ ...params,
            hasAcceptedContext: params.acceptedContext !== null || supportsAnotherRound === true }) ? anotherRound : null,
        start,
    };
}
