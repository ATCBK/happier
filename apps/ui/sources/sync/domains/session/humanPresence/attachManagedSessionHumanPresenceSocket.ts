import { SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT } from '@happier-dev/protocol/sessions';
import type { Socket } from 'socket.io-client';
import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { parseToken } from '@/utils/auth/parseToken';
import { emitWithAckCancellable } from '@happier-dev/sync-client';

/** Shares the existing Home socket and its HTTPS/Iroh lifecycle. */
export function attachManagedSessionHumanPresenceSocket(input: Readonly<{
    serverId: string;
    token: string;
    socket: Socket;
    transport: ManagedConnectionTransport;
}>): () => void {
    let accountId: string;
    try { accountId = parseToken(input.token); } catch { return () => {}; }
    const { socket, transport } = input;
    const controller = new AbortController();
    let disposed = false;
    let detach: (() => void) | undefined;
    // Socket construction must not import the UI storage/hook graph. If loading
    // finishes after connection, attachment samples the existing transport state.
    void import('./sessionHumanPresenceRuntime').then(({ attachSessionHumanPresenceSocket }) => {
        if (disposed) return;
        detach = attachSessionHumanPresenceSocket({
            serverId: input.serverId,
            accountId,
            transport: {
                isConnected: () => transport.isConnected(),
                subscribeStatus: (listener) => {
                    const offConnected = transport.onConnected(listener);
                    const offDisconnected = transport.onDisconnected(listener);
                    return () => { offConnected(); offDisconnected(); };
                },
                sendWithAck: async (event, payload) => await emitWithAckCancellable({
                    socket, event, payload, timeoutMs: null, signal: controller.signal,
                }),
                send: (event, payload) => { if (socket.connected) socket.emit(event, payload); },
                subscribeSnapshot: (listener) => {
                    socket.on(SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT, listener);
                    return () => { socket.off(SESSION_HUMAN_PRESENCE_SNAPSHOT_EVENT, listener); };
                },
            },
        });
    }).catch(() => {
        // Presence is additive; a module load failure leaves its view unavailable.
    });
    return () => { disposed = true; controller.abort(); detach?.(); };
}
