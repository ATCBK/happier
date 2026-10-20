import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionMessageReplyObservationRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { RunnerMcpSessionWithContext } from '@/mcp/runtime/applyRunnerMcpSessionContext';

/** The relay authenticates the source; original input custody decides disposition. */
export function registerSessionMessageReplyObservation(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  session: RunnerMcpSessionWithContext<Pick<ApiSessionClient, 'sessionId' | 'mutateSessionMessageReply'>>;
}>): void {
  params.rpcHandlerManager.registerHandler(SESSION_RPC_METHODS.SESSION_MESSAGE_REPLY_OBSERVE_V1, async (input: unknown, context) => {
    const parsed = SessionMessageReplyObservationRequestV1Schema.safeParse(input);
    if (!parsed.success) return { v: 1, ok: false, error: 'invalid_request' } as const;
    if (context?.sessionActionOrigin?.caller.sessionId !== params.session.sessionId) {
      return { v: 1, ok: false, error: 'forbidden' } as const;
    }
    const signals = [context.signal, params.session.getRuntimeLifetimeSignal?.()]
      .filter((signal): signal is AbortSignal => signal instanceof AbortSignal);
    const signal = AbortSignal.any(signals);
    if (signal.aborted) return { v: 1, ok: false, error: 'unavailable' } as const;
    const { requestSessionId, requestLocalId, operation } = parsed.data;
    return params.session.mutateSessionMessageReply({ requestSessionId, requestLocalId, operation: { kind: operation } }, { signal });
  });
}
