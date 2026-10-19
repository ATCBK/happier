import { expect, it, vi } from 'vitest';

// Only the machine process boundary is simulated; the query adapter handles the result.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: ({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'),
            { code: 'MACHINE_RPC_ABORTED' })), { once: true });
    }),
}));
const { machineExecutionRunsList } = await import('./machineExecutionRuns');

it('settles an unanswered Run listing when its request owner cancels', async () => {
    const controller = new AbortController();
    let result: Awaited<ReturnType<typeof machineExecutionRunsList>> | undefined;
    void machineExecutionRunsList('machine-one', { serverId: 'home-one', signal: controller.signal })
        .then(value => { result = value; });
    controller.abort();
    await vi.waitFor(() => expect(result).toMatchObject({ ok: false, error: 'aborted' }));
});
