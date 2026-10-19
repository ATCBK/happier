import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const probes: { signal: AbortSignal; method: string }[] = [];
let answerPreview = false;
let useFallback = false;
installSessionActionRpcBoundary((request, context) => {
    if (!request.method.endsWith('preview-env') && !request.method.endsWith('bash')) return {};
    probes.push({ method: request.method, signal: context.signal });
    if (request.method.endsWith('preview-env') && useFallback) return { error: 'Method not found', code: 'METHOD_NOT_FOUND' };
    if (request.method.endsWith('preview-env') && answerPreview) return {
        policy: 'redacted', values: { FOO: { value: 'ready', isSet: true, isSensitive: false,
            isForcedSensitive: false, sensitivitySource: 'none', display: 'full' } },
    };
    return new Promise<never>(() => {});
});
// Load the real runtime after its external ports are installed, outside the per-case lifecycle.
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
const keys = ['FOO'];

describe('environment probe lifetimes through the real Machine RPC owner', () => {
    beforeEach(async () => {
        serverId = await homes.addHome({ name: 'Environment', serverUrl: 'https://environment-lifetime.test', accountId: 'account-a' });
        homes.answer(serverId, '/v1/machines/m1', { body: { machine: createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a' }) } });
        account = await restoreServerAccountForTest({ serverUrl: 'https://environment-lifetime.test', accountId: 'account-a', request: homes.request });
        installHomeGovernanceBoundaries(homes);
        (await import('./useMachineEnvPresence')).invalidateMachineEnvPresence();
        probes.length = 0;
        answerPreview = false;
        useFallback = false;
    });
    afterEach(async () => {
        (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool')).serverScopedRpcSocketPool.resetForTests();
        (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool')).resetScopedMachineTransportCacheForTests();
        await account?.dispose();
        account = undefined;
        await homes.reset();
        vi.restoreAllMocks();
    });

    it('shares presence probes, cancels the last consumer, and retries on the next mount', async () => {
        const { useMachineEnvPresence } = await import('./useMachineEnvPresence');
        const first = await renderHook(() => useMachineEnvPresence('m1', keys, { serverId }));
        const second = await renderHook(() => useMachineEnvPresence('m1', keys, { serverId }));
        await vi.waitFor(() => expect(probes).toHaveLength(1));
        await first.unmount();
        expect(probes[0]?.signal.aborted).toBe(false);
        await second.unmount();
        await vi.waitFor(() => expect(probes[0]?.signal.aborted).toBe(true));
        answerPreview = true;
        const retry = await renderHook(() => useMachineEnvPresence('m1', keys, { serverId }));
        try {
            await vi.waitFor(() => expect(retry.getCurrent()).toMatchObject({ isLoading: false, meta: { FOO: { isSet: true } } }));
            expect(probes).toHaveLength(2);
        } finally { await retry.unmount(); }
    });

    it('cancels superseded environment reads and permits a successful next attempt', async () => {
        const { useEnvironmentVariables } = await import('../server/useEnvironmentVariables');
        const hook = await renderHook(({ machineId }) => useEnvironmentVariables(machineId, keys, { serverId }), {
            initialProps: { machineId: 'm1' as string | null },
        });
        await vi.waitFor(() => expect(probes).toHaveLength(1));
        await hook.rerender({ machineId: null });
        await vi.waitFor(() => expect(probes[0]?.signal.aborted).toBe(true));
        expect(hook.getCurrent().isLoading).toBe(false);
        answerPreview = true;
        await hook.rerender({ machineId: 'm1' });
        try {
            await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ isLoading: false, variables: { FOO: 'ready' } }));
        } finally { await hook.unmount(); }
    });

    it('cancels the older-daemon bash fallback on unmount', async () => {
        useFallback = true;
        const { useEnvironmentVariables } = await import('../server/useEnvironmentVariables');
        const hook = await renderHook(() => useEnvironmentVariables('m1', keys, { serverId }));
        await vi.waitFor(() => expect(probes.some(probe => probe.method.endsWith('bash'))).toBe(true));
        const bash = probes.find(probe => probe.method.endsWith('bash'))!;
        await hook.unmount();
        await vi.waitFor(() => expect(bash.signal.aborted).toBe(true));
    });
});
