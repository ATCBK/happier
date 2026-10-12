import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveContext = vi.hoisted(() => vi.fn());
const emitWithAck = vi.hoisted(() => vi.fn());
const disconnect = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn(async () => undefined));
const createSocket = vi.hoisted(() => vi.fn());
afterEach(() => { vi.useRealTimers(); });

vi.mock('@/auth/storage/tokenStorage', () => ({
    subscribeHomeCredentialMutations: () => () => undefined,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext', () => ({
    resolveServerAccountRequestContext: resolveContext,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (params: unknown) => createSocket(params),
}));

describe('emitSessionReadCursorUpdateWithServerScope', () => {
    it('routes the mutation through the captured Home after the active Home changes', async () => {
        resolveContext.mockResolvedValue({
            scope: 'scoped',
            timeoutMs: 1_000,
            targetServerId: 'home-b',
            targetServerUrl: 'https://home-b.example',
            targetAccountId: 'account-b',
            token: 'token-b',
            encryption: null,
            release,
        });
        vi.useFakeTimers();
        let acknowledge!: (value: unknown) => void;
        emitWithAck.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
        createSocket.mockImplementation(async (params: {
            takeCarrierRelease?: () => (() => Promise<void>) | undefined;
        }) => {
            expect(params.takeCarrierRelease?.()).toBe(release);
            return {
                emitWithAck,
                timeout: (timeoutMs: number) => ({ emitWithAck: (...args: unknown[]) => Promise.race([
                    emitWithAck(...args),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('operation has timed out')), timeoutMs)),
                ]) }),
                emit: vi.fn(),
                on: vi.fn(),
                off: vi.fn(),
                getSocketId: () => 'socket-b',
                disconnect,
            };
        });

        const { emitSessionReadCursorUpdateWithServerScope } = await import('./emitSessionReadCursorUpdateWithServerScope');
        const pending = emitSessionReadCursorUpdateWithServerScope(
            { serverId: 'home-b', sessionId: 'same-session' },
            4,
        );
        const outcome = pending.then((value) => value, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(250_000);
        acknowledge({ result: 'success', lastViewedSessionSeq: 4 });
        await expect(outcome).resolves.toEqual({ result: 'success', lastViewedSessionSeq: 4 });
        vi.useRealTimers();

        expect(resolveContext).toHaveBeenCalledWith({ serverId: 'home-b', preferScoped: true });
        expect(emitWithAck).toHaveBeenCalledWith('update-read-cursor', {
            sid: 'same-session',
            lastViewedSessionSeq: 4,
        });
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(release).not.toHaveBeenCalled();
    });
});
