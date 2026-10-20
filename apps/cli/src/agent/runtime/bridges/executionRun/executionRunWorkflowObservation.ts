import type {
  ExecutionRunResumeHandle,
  WorkflowUsageV1,
} from '@happier-dev/protocol';

import type { ExactTurnUsageAccumulator } from '@/usage/exactTurnUsage';
import type { AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecutionRunBackendController } from '@/agent/executionRuns/controllers/types';
import { appendExecutionRunControllerHostBarrier } from '@/agent/executionRuns/controllers/failureSignal';

export type ExecutionRunWorkflowObservation =
  | Readonly<{
      kind: 'project_setup';
      runId: string;
      localInputId: string;
      operation: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1;
    }>
  | Readonly<{
      kind: 'input_accepted';
      runId: string;
      localInputId: string;
      acceptedAtMs: number;
    }>
  | Readonly<{
      kind: 'provider_resume_identity';
      runId: string;
      localInputId: string;
      providerResumeIdentity: Extract<ExecutionRunResumeHandle, { kind: 'provider_session.v1' }>;
    }>
  | Readonly<{
      kind: 'usage';
      runId: string;
      localInputId: string;
      usage: WorkflowUsageV1;
    }>;

/**
 * Host-private, exact-input projection into the Workflow invocation owner.
 * It is carried only over the direct in-process Action path and is never wire
 * input, public Run state, marker content, or a durable Execution Run store.
 */
export type ExecutionRunWorkflowObservationSink = Readonly<{
  /** Host-authored identity from the admitted Workflow invocation owner. */
  workflowRunId?: string;
  commit(observation: ExecutionRunWorkflowObservation): Promise<void>;
}>;

export type ExecutionRunWorkflowObservationBinding = Readonly<{
  workflowRunId?: string;
  localInputId: string;
  sink: ExecutionRunWorkflowObservationSink;
  usage: ExactTurnUsageAccumulator;
}>;

/** Project only native acceptance of the bound input, ordered with other host facts. */
export function projectExecutionRunWorkflowInputAcceptance(
  controller: ExecutionRunBackendController,
  runId: string,
  event: Extract<AgentSessionRuntimeEvent, { kind: 'input-accepted' }>,
): void {
  const binding = controller.workflowObservation;
  if (controller.cancelled || !binding || !event.inputIds.includes(binding.localInputId)) return;
  controller.pendingHostBarrier = appendExecutionRunControllerHostBarrier(
    controller.pendingHostBarrier,
    () => binding.sink.commit({
      kind: 'input_accepted', runId, localInputId: binding.localInputId, acceptedAtMs: event.emittedAtMs,
    }),
  );
}

export function readExecutionRunWorkflowObservationSink(
  value: unknown,
): ExecutionRunWorkflowObservationSink | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof (value as { commit?: unknown }).commit === 'function'
    ? value as ExecutionRunWorkflowObservationSink
    : null;
}
