import { isTerminalAuthError } from '@/sync/runtime/connectivity/authErrors';

export async function socketEmitWithAckFallback<TAck>(params: {
    emitWithAck: (event: string, payload: any, opts?: { timeoutMs?: number | null }) => Promise<TAck>;
    send: (event: string, payload: any) => void;
    event: string;
    payload: any;
    onNoAck: () => void;
    beforeFallback?: () => void | Promise<void>;
}): Promise<TAck | null> {
    const ack: TAck | null = await (async () => {
        try {
            // Admission and transaction retries belong to the server operation.
            // Transport loss, rather than elapsed ACK time, permits reconciliation.
            return await params.emitWithAck(params.event, params.payload, { timeoutMs: null });
        } catch (error) {
            if (isTerminalAuthError(error)) {
                throw error;
            }
            return null;
        }
    })();

    if (!ack || typeof ack !== 'object') {
        await params.beforeFallback?.();
        params.send(params.event, params.payload);
        params.onNoAck();
        return null;
    }

    return ack;
}
