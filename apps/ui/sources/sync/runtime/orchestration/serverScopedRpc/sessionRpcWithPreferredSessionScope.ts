import { resolvePreferredServerIdForSessionId } from './resolvePreferredServerIdForSessionId';
import { sessionRpcWithServerScope } from './serverScopedSessionRpc';
import type { SessionTransferRoutingV1 } from '@happier-dev/protocol/socketRpc';

export async function sessionRpcWithPreferredSessionScope<R, A>(params: Readonly<{
    sessionId: string;
    serverId?: string;
    method: string;
    payload: A;
    timeoutMs?: number | null;
    onIssued?: () => void;
    signal?: AbortSignal;
    transferRouting?: SessionTransferRoutingV1;
}>): Promise<R> {
    return await sessionRpcWithServerScope<R, A>({
        sessionId: params.sessionId,
        serverId: params.serverId ?? resolvePreferredServerIdForSessionId(params.sessionId),
        method: params.method,
        payload: params.payload,
        timeoutMs: params.timeoutMs,
        onIssued: params.onIssued,
        signal: params.signal,
        transferRouting: params.transferRouting,
    });
}
