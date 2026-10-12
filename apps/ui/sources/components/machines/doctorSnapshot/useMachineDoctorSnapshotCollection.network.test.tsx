import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

const boundary = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { useMachineDoctorSnapshotCollection } = await import('./useMachineDoctorSnapshotCollection');
let home: Awaited<ReturnType<typeof boundary.addHome>>;

afterAll(() => boundary.dispose());
beforeEach(async () => {
    boundary.resetRequests();
    resetScopedMachineTransportCacheForTests();
    home = await boundary.addHome('https://doctor-collection.example.test', 'doctor-account');
    boundary.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
        ? Response.json({ mode: 'plain', updatedAt: 1 })
        : null);
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});

describe('doctor snapshot prefetch through machine RPC', () => {
    it('starts every selected machine without waiting for the first reply', async () => {
        const reply = createDeferred<void>();
        boundary.setRpcAckResponder(async () => {
            await reply.promise;
            return { ok: false, error: 'Machine unavailable' };
        });
        const targets = ['doctor-a', 'doctor-b', 'doctor-c'].map((machineId) => ({ serverId: home.id, machineId }));
        const hook = await renderHook(() => useMachineDoctorSnapshotCollection({
            machineDoctorSnapshotTargets: targets,
            prefetchMachineDoctorSnapshotTargets: targets,
        }));
        try {
            await flushHookEffects({ cycles: 3, turns: 3 });
            expect(targets.map((target) => hook.getCurrent().readMachineDoctorSnapshotState(target)?.status))
                .toEqual(['loading', 'loading', 'loading']);
            await vi.waitFor(() => expect(boundary.requests.map((request) => request.targetId).sort())
                .toEqual(['doctor-a', 'doctor-b', 'doctor-c']));
        } finally {
            await act(async () => { reply.resolve(); });
        }
    });

    it('shares an in-flight fetch when the page is unmounted and reopened', async () => {
        const reply = createDeferred<void>();
        const issued = createDeferred<void>();
        boundary.setRpcAckResponder(async () => {
            issued.resolve();
            await reply.promise;
            return { ok: false, error: 'Machine unavailable' };
        });
        const target = { serverId: home.id, machineId: 'doctor-reopen' };
        const input = { machineDoctorSnapshotTargets: [target], prefetchMachineDoctorSnapshotTargets: [target] };
        const first = await renderHook(() => useMachineDoctorSnapshotCollection(input));
        await issued.promise;
        await first.unmount();
        const reopened = await renderHook(() => useMachineDoctorSnapshotCollection(input));
        try {
            await flushHookEffects({ cycles: 3, turns: 3 });
            await act(async () => { reply.resolve(); });
            await flushHookEffects({ cycles: 3, turns: 3 });
            expect(reopened.getCurrent().readMachineDoctorSnapshotState(target)?.status).toBe('error');
            // Duplicate dispatch is the observable defect: page navigation must
            // join the original remote request, not launch another daemon check.
            expect(boundary.requests.filter((request) => request.targetId === target.machineId)).toHaveLength(1);
            await reopened.unmount();
            const refreshed = await renderHook(() => useMachineDoctorSnapshotCollection(input));
            await vi.waitFor(() => expect(refreshed.getCurrent().readMachineDoctorSnapshotState(target)?.status).toBe('error'));
            expect(boundary.requests.filter((request) => request.targetId === target.machineId)).toHaveLength(2);
        } finally {
            await act(async () => { reply.resolve(); });
        }
    });
});
