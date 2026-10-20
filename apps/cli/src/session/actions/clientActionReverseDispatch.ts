import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import {
  UiActionDispatchRequestV1Schema,
  clientActionUnavailable,
  currentUiContextCommandClientRpcMethod,
  currentUiContextReadClientRpcMethod,
  mountedWorkReadClientRpcMethod,
  parseClientActionDispatchResult,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { projectApprovalExecutionOriginCaller } from '@happier-dev/protocol/actions/actionExecutor';
import { isWorkflowAuthoringActionId, workflowDraftClientRpcMethod, WorkflowDraftGetInputV1Schema } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { PluginExecutionOriginActionIdSchema, PluginExecutionOriginActionInputSchemas } from '@happier-dev/protocol/actions/pluginExecutionOriginActionFamily';
import type { SocketRpcAnsweringClientV1 } from '@happier-dev/protocol/socketRpc';

export type ClientActionMachineRpc = Readonly<{
  hasConnectedClientRpcHandler(method: string): boolean;
  callConnectedClientRpc(method: string, params: unknown,
    options: Readonly<{ timeoutMs: null; signal?: AbortSignal; answeringClient?: SocketRpcAnsweringClientV1; onIssued(): void }>):
    Promise<Readonly<{ ok: true; result: unknown; answeringClientId?: string; answeringClientIds?: readonly string[] }> | Readonly<{ ok: false; errorCode?: string }>>;
}>;

/** One delivery owner for every built-in client-placed Action; no retry after issuance. */
export function createClientActionReverseDispatcher(
  getMachineClient: () => ClientActionMachineRpc | null | undefined,
): NonNullable<ActionExecutorDeps['clientActionExecute']> {
  return async ({ actionId, input, context }) => {
    const unavailable = () => clientActionUnavailable(actionId);
    const machineTransportUnavailable = (errorCode = 'machine_transport_unavailable') => ({
      ok: false as const, errorCode, error: errorCode,
    });
    const client = getMachineClient();
    const originAction = PluginExecutionOriginActionIdSchema.safeParse(actionId);
    const originInput = originAction.success ? PluginExecutionOriginActionInputSchemas[originAction.data].parse(input) : null;
    const answeringClient = originInput ? { ...(originInput.clientId ? { clientId: originInput.clientId } : {}),
      ...(actionId === 'plugins.execution_origin.list' ? {} : { requireSingle: true as const }) } : undefined;
    // Project only the address from the already-admitted full Action input.
    const address = isWorkflowAuthoringActionId(actionId) && input && typeof input === 'object'
      ? WorkflowDraftGetInputV1Schema.safeParse({ scope: Reflect.get(input, 'scope'), draftId: Reflect.get(input, 'draftId') }) : null;
    const method = actionId === 'session.work.get' && input && typeof input === 'object'
      && typeof Reflect.get(input, 'sessionId') === 'string'
      ? mountedWorkReadClientRpcMethod(actionId, Reflect.get(input, 'sessionId'))
      : actionId === 'inbox.get' ? mountedWorkReadClientRpcMethod(actionId)
      : actionId === 'ui.current_context.read' ? currentUiContextReadClientRpcMethod()
      : (actionId === 'ui.current_context.command.invoke' || actionId === 'account.home_continuation.invoke')
        && input && typeof input === 'object'
        && typeof Reflect.get(input, 'commandId') === 'string'
        ? currentUiContextCommandClientRpcMethod(Reflect.get(input, 'commandId'))
      : address?.success ? workflowDraftClientRpcMethod(address.data) : RPC_METHODS.UI_ACTION_EXECUTE;
    if (!client) return machineTransportUnavailable();
    if (!client.hasConnectedClientRpcHandler(method)) return unavailable();
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const actionCaller = context.actionCaller ? projectApprovalExecutionOriginCaller(context.actionCaller) : undefined;
    if (context.actionCaller && !actionCaller) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const request = UiActionDispatchRequestV1Schema.safeParse({ v: 1, actionId, input, context: {
      surface: context.surface ?? 'agent', authority: context.authority ?? 'account_automation',
      ...(context.defaultSessionId ? { defaultSessionId: context.defaultSessionId } : {}),
      ...(context.defaultSessionMachineId ? { defaultSessionMachineId: context.defaultSessionMachineId } : {}),
      ...(context.agentStartWorkspaceWrites ? { agentStartWorkspaceWrites: context.agentStartWorkspaceWrites } : {}),
      ...(actionCaller ? { actionCaller } : {}),
      ...(context.actionRequestId ? { actionRequestId: context.actionRequestId } : {}),
      ...(context.externalActionCredential ? { externalActionCredential: context.externalActionCredential } : {}),
      ...(context.externalActionTarget ? { externalActionTarget: context.externalActionTarget } : {}),
    } });
    if (!request.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    let issued = false;
    const unknownOutcome = () => ({ ok: false as const, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' });
    try {
      const response = await client.callConnectedClientRpc(method, request.data, {
        ...(answeringClient ? { answeringClient } : {}),
        timeoutMs: null, ...(context.signal ? { signal: context.signal } : {}), onIssued: () => {
          issued = true;
          context.onTransportIssued?.();
        },
      });
      if (!response.ok) {
        if (response.errorCode === RPC_ERROR_CODES.CLIENT_AMBIGUOUS) return { ok: false, errorCode: 'client_ambiguous', error: 'Choose an exact answering client' };
        if (response.errorCode === RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE) return unavailable();
        if (answeringClient && response.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return { ok: false,
          errorCode: 'client_routing_update_required', error: 'Update the Home server to support answering-client routing' };
        if (response.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return unavailable();
        return issued ? unknownOutcome() : machineTransportUnavailable(response.errorCode);
      }
      const execution = parseClientActionDispatchResult(actionId, response.result);
      if (actionId === 'plugins.execution_origin.list' && execution?.ok && execution.result
        && typeof execution.result === 'object' && Reflect.get(execution.result, 'status') === 'available' && response.answeringClientId) {
        return { ...execution, result: { ...execution.result, answeringClientId: response.answeringClientId,
          ...(response.answeringClientIds ? { answeringClientIds: [...response.answeringClientIds] } : {}) } };
      }
      return execution ?? unknownOutcome();
    } catch {
      return issued ? unknownOutcome() : machineTransportUnavailable();
    }
  };
}
