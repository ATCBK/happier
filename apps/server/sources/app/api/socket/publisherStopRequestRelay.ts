import type { Server } from "socket.io";
import type { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";

/**
 * Socket.IO cluster-adapter server-side event: an instance relayed a session stop request that a runner
 * accepted, but the runner's socket (and its publisher registration) lives on another instance.
 */
export const SESSION_PUBLISHER_STOP_REQUESTED_SERVER_EVENT = "happier:session-publisher-stop-requested";

type StopRequestPresence = Pick<ReturnType<typeof createSessionPublisherPresence>, "markPublisherStopRequested">;

type RelayParams = Readonly<{ io: Server; presence: StopRequestPresence }>;

function markLocalPublisherStopRequested(params: RelayParams & Readonly<{ socketId: string }>): boolean {
    const socket = params.io.sockets.sockets.get(params.socketId);
    if (!socket) return false;
    params.presence.markPublisherStopRequested({ socket });
    return true;
}

/**
 * Marks an accepted stop request for a runner reached through the cluster adapter. The instance that owns
 * the socket applies the mark; if the runner already disconnected there, its exit settles through the
 * presence timeout as before. Only valid with a cluster adapter: the in-memory adapter rejects
 * `serverSideEmit`.
 */
export function markRelayedPublisherStopRequested(params: RelayParams & Readonly<{ socketId: string }>): void {
    if (markLocalPublisherStopRequested(params)) return;
    params.io.serverSideEmit(SESSION_PUBLISHER_STOP_REQUESTED_SERVER_EVENT, { socketId: params.socketId });
}

export function registerPublisherStopRequestReceiver(params: RelayParams): void {
    params.io.on(SESSION_PUBLISHER_STOP_REQUESTED_SERVER_EVENT, (payload: unknown) => {
        const socketId = (payload as { socketId?: unknown } | null)?.socketId;
        if (typeof socketId !== "string" || socketId.length === 0) return;
        markLocalPublisherStopRequested({ ...params, socketId });
    });
}
