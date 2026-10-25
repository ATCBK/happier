import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import { ExecutionRunGetResponseSchema, ExecutionRunWaitResultSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { AutomationRunLifecycleSource, AutomationRunLifecycleOccurrenceEvidenceV1 } from '@happier-dev/protocol';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { readActionCompletionRunObservationV1 } from '@happier-dev/protocol/actions/actionCompletion';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol/scm/diffSummary';

type Source = Extract<AutomationRunLifecycleSource, { kind: 'execution_run' }>;

/** Composes the existing event-backed Run wait, including its retained baseline/reconnect read. */
export function createAutomationRunLifecycleObservers(deps: Readonly<{
  executor: Pick<ReturnType<typeof createActionExecutor>, 'execute'>;
  report: (occurrence: AutomationRunLifecycleOccurrenceEvidenceV1, signal: AbortSignal) => Promise<void>;
  onError: (error: unknown, source: Source) => void;
}>) {
  const observers = new Map<string, AbortController>();
  const clear = () => {
    for (const controller of observers.values()) controller.abort();
    observers.clear();
  };
  return {
    clear,
    replace(sources: readonly Source[]) {
      const current = new Map(sources.map(source => [JSON.stringify(source), source]));
      for (const [key, controller] of observers) {
        if (current.has(key)) continue;
        controller.abort();
        observers.delete(key);
      }
      for (const [key, source] of current) {
        if (observers.has(key)) continue;
        const controller = new AbortController();
        observers.set(key, controller);
        void (async () => {
          try {
            while (!controller.signal.aborted) {
              const executed = await deps.executor.execute(source.observation ? 'execution.run.get' : 'execution.run.wait', {
                runId: source.runId, sessionId: source.sessionId ?? null,
                ...(source.observation ? { includeStructured: true, waitForOutput: source.observation } : {}),
              }, { surface: 'cli', authority: 'account_automation', executionRunTargetMachineId: source.machineId, signal: controller.signal });
              if (controller.signal.aborted) return;
              if (!executed.ok) throw Object.assign(new Error(executed.errorCode), { code: executed.errorCode });
              if (source.observation) {
                const snapshot = ExecutionRunGetResponseSchema.parse(executed.result);
                if (snapshot.run.runId !== source.runId) throw new Error('execution_run_source_mismatch');
                const outcome = readActionCompletionRunObservationV1(snapshot, source.observation);
                // The host's event-backed wait owns pending output. A returned unresolved
                // snapshot is not completion and must never become a local polling loop.
                if (outcome.kind === 'outcome_uncertain') throw Object.assign(new Error(outcome.code), { code: outcome.code });
                const output = createStoredReadSchema(ScmDiffSummaryGenerateOutputSchema).safeParse(
                  snapshot.structuredMeta?.kind === EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary ? snapshot.structuredMeta.payload : snapshot.latestToolResult);
                const sourceRevision = output.success ? output.data.revision ?? snapshot.run.finishedAtMs : snapshot.run.finishedAtMs;
                if (sourceRevision === undefined) throw new Error('execution_run_terminal_fact_unavailable');
                await deps.report({ v: 1, kind: 'runLifecycle', source, condition: 'terminal', sourceRevision,
                  // Saved results have revisions rather than completion timestamps.
                  occurredAt: snapshot.run.finishedAtMs ?? Date.now(),
                  ...(snapshot.run.originWorkflowRunId ? { originRunId: snapshot.run.originWorkflowRunId } : {}),
                }, controller.signal);
                return;
              }
              const result = ExecutionRunWaitResultSchema.parse(executed.result);
              if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code });
              // Only the canonical wait's observation timeout reopens its event subscription.
              if (result.status === 'running') continue;
              if (result.result.run.runId !== source.runId) throw new Error('execution_run_source_mismatch');
              const finishedAt = result.result.run.finishedAtMs;
              if (finishedAt === undefined) throw new Error('execution_run_terminal_fact_unavailable');
              await deps.report({ v: 1, kind: 'runLifecycle', source, condition: 'terminal',
                sourceRevision: finishedAt, occurredAt: finishedAt,
                ...(result.result.run.originWorkflowRunId ? { originRunId: result.result.run.originWorkflowRunId } : {}) }, controller.signal);
              return;
            }
          } catch (error) {
            if (controller.signal.aborted) return;
            // Incumbent assignment refresh/reconnect retries from the retained terminal owner.
            if (observers.get(key) === controller) observers.delete(key);
            deps.onError(error, source);
          }
        })();
      }
    },
  };
}
