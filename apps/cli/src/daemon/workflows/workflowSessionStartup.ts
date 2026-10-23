import { ActionOperationGetV1ResponseSchema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionCompletionOperation } from '@happier-dev/protocol/actions/actionCompletion';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { ActionOperationRpcContext } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createSpawnedSession, type DirectSpawnedSessionTransport } from '@/session/services/createSpawnedSession';
import { classifyWorkflowAbort, WorkflowRuntimeInterruption } from './coordinator';
import type { WorkflowSessionStartup } from './sessionStepExecutor';
import { WorkflowSessionCompositionError } from './workflowConversation';
import { deriveSessionCreationTagV1, type SessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { prepareRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { readRetainedWorkflowSessionStartupFailure } from './workflowSessionStartupFailure';

/** The original startup operation, rather than its Workflow observer, owns launch custody. */
export async function prepareWorkflowSessionRequester(
  input: Parameters<typeof prepareRequesterSessionBootstrap>[0],
): ReturnType<typeof prepareRequesterSessionBootstrap> {
  const { signal, ...requester } = input;
  signal?.throwIfAborted();
  // This signal observes the Workflow claim. Once startup is accepted, its
  // existing Action operation supplies cancellation to the launch transport.
  // Keep the bootstrap's own disposal/currentness lifetime for that handoff.
  const prepared = await prepareRequesterSessionBootstrap(requester);
  if (signal?.aborted) {
    await prepared?.cleanupOnFailure();
    signal.throwIfAborted();
  }
  return prepared;
}

/** Creation and restart discovery share the same immutable Workflow birth identity. */
export function deriveWorkflowSessionCreationTag(serverId: string, runId: string, creationKey: string): SessionCreationTagV1 {
  return deriveSessionCreationTagV1({ callerCreationNamespace: JSON.stringify(['workflow', serverId, runId]), creationKey });
}

/** The installed Workflow caller supplies its actual admitted host, not Account defaults. */
export type WorkflowSessionStartupHost = Readonly<{
  serverId: string;
  machineId: string;
  observeExecution: HostActionOperationRuntime['observeExecution'];
  rpcContext: ActionOperationRpcContext;
  transport(operation: Parameters<Parameters<HostActionOperationRuntime['observeExecution']>[0]['execute']>[0]): DirectSpawnedSessionTransport;
  observeOperation(operation: ActionCompletionOperation, options: Readonly<{
    waitForTerminal: boolean; includeSetupReview: boolean; signal?: AbortSignal;
  }>): Promise<unknown>;
  cancelOperation(operation: ActionCompletionOperation): Promise<unknown>;
  cleanupOnFailure(): Promise<void>;
}>;

/** Retain the ordinary creator until native open, projecting only its original operation. */
export async function runObservedWorkflowSessionStartup(
  input: Parameters<WorkflowSessionStartup>[0],
  host: WorkflowSessionStartupHost,
): ReturnType<WorkflowSessionStartup> {
  const signal = input.request.signal;
  let address = input.retainedOperation;
  const read = async (waitForTerminal: boolean, includeSetupReview: boolean, readSignal = signal) => {
    const parsed = ActionOperationGetV1ResponseSchema.parse(await host.observeOperation(address!, {
      waitForTerminal, includeSetupReview, ...(readSignal ? { signal: readSignal } : {}),
    }));
    const operation = parsed.kind === 'found' ? parsed.operation
      : readRetainedWorkflowSessionStartupFailure(input.retainedOperationSnapshot, address!, input.creationKey);
    if (!operation || address!.serverId !== host.serverId || address!.machineId !== host.machineId
      || operation.operationId !== address!.operationId || operation.requestId !== input.creationKey
      || operation.actionId !== 'session.spawn_new' || operation.scope.machineId !== host.machineId) {
      throw new Error('workflow_invocation_fact_conflict');
    }
    return operation;
  };
  const rejectFromOriginalOperation = async (error: unknown): Promise<never> => {
    if (!address || signal?.aborted) throw error;
    const operation = await read(false, false);
    if (operation.state !== 'failed') throw error;
    // The original operation proves failure even when creation rejects before
    // returning an acceptance reply. Preserve its terminal fact for recovery.
    await input.onObservation?.(operation);
    throw new WorkflowSessionCompositionError(operation.error?.errorCode ?? 'workflow_session_startup_unavailable',
      operation.error?.error ?? 'workflow_session_startup_unavailable');
  };
  const abort = () => {
    if (address && classifyWorkflowAbort(signal) !== 'interrupted') void host.cancelOperation(address).catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) {
      if (classifyWorkflowAbort(signal) === 'interrupted') throw new WorkflowRuntimeInterruption();
      if (address) await host.cancelOperation(address);
      signal.throwIfAborted();
    }
    if (!address) {
      let retained!: () => void;
      let refused!: (error: unknown) => void;
      const admission = new Promise<void>((resolve, reject) => { retained = resolve; refused = reject; });
      let rejoinedRetention: Promise<void> | undefined;
      const launch = host.observeExecution({ actionId: 'session.spawn_new',
        input: { creationKey: input.creationKey, directory: input.request.directory,
          machineId: host.machineId, agentTarget: input.request.agentTarget ?? null },
        actionRequestId: input.creationKey, rpcContext: host.rpcContext,
        onOperation: operation => {
          address = { key: 'startup', serverId: host.serverId, machineId: host.machineId, operationId: operation.operationId };
          if (signal?.aborted) abort();
          if (operation.state === 'running') {
            // An active same-key launch skips this caller's execute callback.
            // Retain its exact correspondence before observing it independently.
            rejoinedRetention = read(false, false).then(snapshot => input.onObservation?.(snapshot));
            void rejoinedRetention.then(retained, refused);
          }
        },
        execute: async operation => {
          const operationId = operation.operationAcceptance?.operationId;
          if (!operationId) return { ok: false, errorCode: 'workflow_session_startup_observation_unavailable', error: 'workflow_session_startup_observation_unavailable' };
          address = { key: 'startup', serverId: host.serverId, machineId: host.machineId, operationId };
          if (signal?.aborted && classifyWorkflowAbort(signal) !== 'interrupted') {
            await host.cancelOperation(address);
            return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
          }
          try {
            // Retain the original operation before launch. A direct refusal
            // can settle observeExecution without returning an accepted reply.
            // Recovery still needs this exact owner, including after Cancel.
            await (rejoinedRetention ?? input.onObservation?.(await read(false, false, operation.signal)));
            // Retaining correspondence can outlast a claim. Only explicit
            // Workflow stop authority, or the operation's own cancellation,
            // may stop the admitted launch after that durable handoff.
            if (signal?.aborted && classifyWorkflowAbort(signal) !== 'interrupted') {
              await host.cancelOperation(address);
              signal.throwIfAborted();
            }
            operation.signal.throwIfAborted();
            retained();
            // The original operation controls execution. A lost Workflow claim
            // ends observation but cannot cancel or replace admitted startup.
            const created = await createSpawnedSession({ ...input.request, signal: operation.signal,
              directTransport: host.transport(operation) });
            return { ok: true, result: { sessionId: created.sessionId } };
          } catch (error) {
            await host.cleanupOnFailure();
            if (operation.signal.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
            throw error;
          }
        } });
      // Start observing as soon as correspondence is retained, even when the
      // keyed launch caller waits for native completion. The race also handles
      // a later launch rejection after this observer has left its claim.
      const response = await Promise.race([admission, launch]).catch(rejectFromOriginalOperation);
      if (response && !response.ok) await rejectFromOriginalOperation(Object.assign(new Error(response.error), { code: response.errorCode }));
    }
    if (!address || address.serverId !== host.serverId || address.machineId !== host.machineId) {
      throw new Error('workflow_invocation_fact_conflict');
    }
    let operation = await read(false, false);
    await input.onObservation?.(operation);
    if (operation.state === 'running' || operation.state === 'accepted') {
      operation = await read(true, true);
      await input.onObservation?.(operation);
      if (operation.setupReview) operation = await read(true, false);
    }
    if (operation.state === 'cancelled') throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    if (operation.state === 'failed') throw new WorkflowSessionCompositionError(
      operation.error?.errorCode ?? 'workflow_session_startup_unavailable',
      operation.error?.error ?? 'workflow_session_startup_unavailable');
    if (operation.state !== 'succeeded') throw Object.assign(new Error(operation.error?.error ?? 'workflow_session_startup_unavailable'), {
      code: operation.error?.errorCode ?? 'workflow_session_startup_unavailable',
    });
    const result = operation.result;
    if (!result || typeof result !== 'object' || Array.isArray(result) || !('sessionId' in result)
      || typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('workflow_invocation_fact_conflict');
    return { sessionId: result.sessionId };
  } catch (error) {
    if (!address) await host.cleanupOnFailure();
    if (signal?.aborted && classifyWorkflowAbort(signal) === 'interrupted') throw new WorkflowRuntimeInterruption();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
