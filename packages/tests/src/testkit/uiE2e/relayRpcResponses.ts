import type { Page } from '@playwright/test';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

type RelayRpcAck = Readonly<{ ok?: unknown; error?: unknown; errorCode?: unknown; result?: unknown }>;
type MethodResponse = Readonly<{ method: string; ack: RelayRpcAck }>;
type ObservedCall = Readonly<{ method: string; injected: boolean }>;

/** Inject one exact relay RPC response while preserving every other WebSocket frame. */
export async function attachRelayRpcResponses(page: Page): Promise<Readonly<{
    calls: () => readonly ObservedCall[];
    setMethodResponse: (response: MethodResponse | null) => void;
}>> {
    const calls: ObservedCall[] = [];
    let response: MethodResponse | null = null;
    await page.routeWebSocket((url) => url.pathname === '/v1/updates/', (route) => {
        const upstream = route.connectToServer();
        route.onMessage((message) => {
            const match = typeof message === 'string' ? /^42(?:\/[^,]*,)?(\d+)(\[[\s\S]*\])$/u.exec(message) : null;
            if (match) {
                let payload: unknown;
                try { payload = JSON.parse(match[2]!); } catch { /* Non-JSON frames pass through. */ }
                const request: unknown = Array.isArray(payload) && payload[0] === SOCKET_RPC_EVENTS.CALL ? payload[1] : null;
                const method = request && typeof request === 'object' && 'method' in request ? request.method : null;
                if (typeof method === 'string') {
                    const injected = response?.method === method;
                    calls.push({ method, injected });
                    if (injected && response) {
                        route.send(`43${match[1]}${JSON.stringify([response.ack])}`);
                        return;
                    }
                }
            }
            upstream.send(message);
        });
        upstream.onMessage((message) => route.send(message));
    });
    return { calls: () => calls, setMethodResponse: (next) => { response = next; } };
}
