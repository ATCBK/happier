import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, isRpcMethodNotFoundResult } from '@happier-dev/protocol/rpcErrors';
import { UiContributedActionExecuteResponseV1Schema, type UiContributedActionExecuteRequestV1, type UiContributedActionExecuteResponseV1 } from '@happier-dev/protocol/plugins/actions/clientInvocationV1';

type ClientActionMachineRpc = Readonly<{
  callConnectedClientRpc(
    method: string,
    params: unknown,
    options: Readonly<{ timeoutMs: null; signal?: AbortSignal; onIssued(): void }>,
  ): Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; errorCode?: string; error?: string }>>;
}>;

function unavailable(): UiContributedActionExecuteResponseV1 {
  return {
    ok: false, errorCode: 'plugin_action_client_target_unavailable',
    error: 'No answering UI client is available', actionHandlerInvocation: 'notStarted',
  };
}

/** Uses the existing machine socket once; an uncertain effect is never retried. */
export function createClientActionMachineRpcExecutor(
  getMachineClient: () => ClientActionMachineRpc | null | undefined,
): (request: UiContributedActionExecuteRequestV1, options: Readonly<{ signal?: AbortSignal }>) => Promise<UiContributedActionExecuteResponseV1> {
  return async (request, options) => {
    const client = getMachineClient();
    // Positive reconnect advertisements cannot prove absence. The authenticated
    // live RPC registry selects the responder; this owner settles its receipt.
    if (!client) {
      return unavailable();
    }
    let issued = false;
    const unknownOutcome = (): UiContributedActionExecuteResponseV1 => ({
      ok: false, errorCode: 'plugin_action_outcome_unknown',
      error: 'The answering UI Action outcome is unknown',
    });
    try {
      const response = await client.callConnectedClientRpc(
        RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE, request,
        { timeoutMs: null, ...(options.signal ? { signal: options.signal } : {}), onIssued: () => { issued = true; } },
      );
      if (!response.ok) {
        // Canonical method refusal proves the server routed no handler even
        // when the outbound request had already been issued.
        return !issued || response.errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
          || response.errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
          ? unavailable() : unknownOutcome();
      }
      if (isRpcMethodNotFoundResult(response.result)) return unavailable();
      const parsed = UiContributedActionExecuteResponseV1Schema.safeParse(response.result);
      return parsed.success ? parsed.data : unknownOutcome();
    } catch {
      return issued ? unknownOutcome() : unavailable();
    }
  };
}
