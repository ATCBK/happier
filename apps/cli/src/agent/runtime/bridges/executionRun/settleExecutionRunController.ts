import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { createExecutionRunCodedError } from './errors';

export function isExecutionRunControllerCurrent(args: Readonly<{
  runId: string;
  controller: ExecutionRunController;
  controllers: ReadonlyMap<string, ExecutionRunController>;
}>): boolean {
  return !args.controller.cancelled && args.controllers.get(args.runId) === args.controller;
}

export async function settleExecutionRunController(args: Readonly<{
  runId: string;
  controller: ExecutionRunController;
  controllers: Map<string, ExecutionRunController>;
}>): Promise<void> {
  if (!args.controller.settlementPromise) {
    args.controller.settlementPromise = (async () => {
      try {
        // Persist terminal cleanup custody before backend disposal asks the
        // daemon to release the materialized root. This prevents a late marker
        // write from recreating an already-cleared cleanup receipt.
        await args.controller.terminalMarkerWritePromise;
      } catch {
        // Marker writes are best effort; the terminal waiter still has to settle.
      }
      if (args.controller.kind === 'backend') {
        args.controller.currentInputPermissionRequestStore?.releaseResponseTarget();
        const liveInterventionRetired = createExecutionRunCodedError(
          'execution_run_not_allowed',
          'Execution run is no longer running',
        );
        const activeLiveIntervention = args.controller.activeLiveIntervention;
        args.controller.activeLiveIntervention = undefined;
        const queuedLiveInterventions = args.controller.admittedLiveInterventions.splice(0);
        args.controller.admittedLiveInterventionsSignal?.resolve();
        args.controller.admittedLiveInterventionsSignal = null;
        const unsettledLiveInterventions = new Set([
          ...(activeLiveIntervention ? [activeLiveIntervention] : []),
          ...queuedLiveInterventions,
        ]);
        for (const pending of unsettledLiveInterventions) {
          try {
            pending.reject(liveInterventionRetired);
          } catch {
            // A caller callback cannot block controller retirement.
          }
        }
      }
      // Both controller families retire their occurrence before provider
      // cleanup. Backend registrations also carry target input custody.
      const release = args.controller.releaseSessionInputAttachment;
      args.controller.releaseSessionInputAttachment = undefined;
      if (release) {
        try {
          await release();
        } catch {
          // Retirement is best effort; the terminal waiter still has to settle.
        }
      }
      if (args.controller.kind === 'backend') {
        const backend = args.controller.backend;
        try {
          await backend.abortPendingPermissionRequests?.('Execution run settled');
        } catch {
          // Permission cleanup is best effort, but it is awaited so a healthy
          // runtime settles its exact pending rows before controller retirement.
        } finally {
          args.controller.currentInputPermissionRequestStore = undefined;
        }
        // Plugin cleanup starts only after terminal-marker custody is settled,
        // but is deliberately detached. A provider may never settle dispose;
        // terminal waiters and controller retirement remain host-owned truth.
        void Promise.resolve()
          .then(async () => await backend.dispose())
          .catch(() => undefined);
      }
      args.controller.resolveTerminal();
      if (args.controllers.get(args.runId) === args.controller) {
        args.controllers.delete(args.runId);
      }
    })();
  }
  await args.controller.settlementPromise;
}
