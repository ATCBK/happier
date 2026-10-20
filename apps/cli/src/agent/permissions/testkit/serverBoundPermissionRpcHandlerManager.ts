import type { RpcHandler } from '@/api/rpc/types';

/**
 * Test-only RPC boundary for permission-response behavior. Production account
 * actors are minted by the authenticated server; tests that exercise a normal
 * present-user response must model that boundary instead of calling the daemon
 * handler raw.
 */
type RegisteredRpcHandler = (payload: unknown, context?: unknown) => unknown | Promise<unknown>;

function serverStampedPermissionContext(sessionId: string) {
    return {
        signal: new AbortController().signal,
        authorization: {
            kind: 'session.permission.respond' as const,
            sessionId,
            actor: {
                kind: 'accountUser' as const,
                accountId: 'account-owner',
                relationship: 'owner' as const,
            },
        },
    };
}

export class ServerBoundPermissionRpcHandlerManager {
    handlers = new Map<string, RegisteredRpcHandler>();

    constructor(private readonly sessionId: string) {}

    registerHandler<TRequest = unknown, TResponse = unknown>(name: string, handler: RpcHandler<TRequest, TResponse>): void {
        // RPC transports deliver unknown payloads; the registered handler owns
        // parsing them. Keep this type erasure at the server boundary.
        const invoke: RegisteredRpcHandler = (payload, context) => Reflect.apply(handler, undefined, [payload, context]);
        if (name !== 'permission' && name !== 'session.permission.respond') {
            this.handlers.set(name, invoke);
            return;
        }
        this.handlers.set(name, (payload, context) => invoke(
            payload,
            context ?? serverStampedPermissionContext(this.sessionId),
        ));
    }
}
