import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import type { StorageState } from '@/sync/store/types';
import { registerStorageStateReader, registerStorageStateSubscribe } from '@/sync/domains/state/storageStateReaderBridge';
import { readProjectAccountWorkspaceRefs, useProjectAccountWorkspaceRef, useProjectAccountWorkspaceRefs, type ProjectAccountRowsSnapshot } from './projectAccountRows';

const scope = { serverId: 'home-a', accountId: 'account-a' };
afterEach(() => {
    standardCleanup();
    registerStorageStateSubscribe(() => () => {});
});

describe('Project workspace-ref subscription', () => {
    it('keeps a complete admitted census during transient refresh but withdraws private authority', () => {
        const rows: ProjectAccountRowsSnapshot = { scope, status: 'ready', coverage: 'complete', workspaceRefs: [
            { id: 'accepted', serverId: scope.serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1 },
        ], relationships: [], organizations: [], revisionsByPhysicalKey: {} };
        for (const status of ['ready', 'loading', 'error'] as const) expect(readProjectAccountWorkspaceRefs({
            profileScope: scope, projectAccountRows: { ...rows, status },
        })).toBe(rows.workspaceRefs);
        for (const status of ['locked', 'refused', 'idle'] as const) expect(readProjectAccountWorkspaceRefs({
            profileScope: scope, projectAccountRows: { ...rows, status },
        })).toBeUndefined();
        expect(readProjectAccountWorkspaceRefs({ profileScope: { ...scope, accountId: 'other' }, projectAccountRows: rows })).toBeUndefined();
    });
    it('subscribes only on demand to ready refs and ignores unrelated catalog records', async () => {
        const storage = createStore<{ projectAccountRows: ProjectAccountRowsSnapshot | null; profileScope: typeof scope; isDataReady: boolean }>()(() => ({
            projectAccountRows: null, profileScope: scope, isDataReady: false,
        }));
        // Real Zustand store with exactly the fields this registered bridge reader consumes.
        registerStorageStateReader(() => storage.getState() as unknown as StorageState);
        let subscriptions = 0;
        registerStorageStateSubscribe(listener => {
            subscriptions += 1;
            // The application reader is typed to its full store; this fixture supplies its actual Project slice.
            const unsubscribe = storage.subscribe(state => listener(state as unknown as StorageState));
            return () => { subscriptions -= 1; unsubscribe(); };
        });
        let identityReads = 0;
        const rows: ProjectAccountRowsSnapshot = { scope, status: 'ready', coverage: 'complete',
            workspaceRefs: Array.from({ length: 1_000 }, (_, index) => ({
                get id() { identityReads += 1; return index === 0 ? 'checkout' : `other-${index}`; },
                serverId: scope.serverId, projectKey: 'project', machineId: 'machine', rootPath: `/repo-${index}`, createdAtMs: 1,
            })),
            relationships: [], organizations: [], revisionsByPhysicalKey: {} };
        storage.setState({ profileScope: scope, projectAccountRows: rows });
        let renders = 0;
        const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
            renders += 1;
            return useProjectAccountWorkspaceRefs(enabled);
        }, { initialProps: { enabled: false } });
        expect(hook.getCurrent()).toBeUndefined();
        expect(subscriptions).toBe(0);
        await hook.rerender({ enabled: true });
        expect(hook.getCurrent()).toBe(rows.workspaceRefs);
        expect(subscriptions).toBe(1);
        const before = renders;
        await act(async () => storage.setState({ projectAccountRows: { ...rows, organizations: [{ key: { kind: 'project-organization', serverId: scope.serverId, projectKey: 'project' }, revision: 1, value: { pinned: true } }] } }));
        expect(renders).toBe(before);
        await act(async () => storage.setState({ projectAccountRows: { ...rows, coverage: 'partial' } }));
        expect(hook.getCurrent()).toBeUndefined();
        await act(async () => storage.setState({ projectAccountRows: rows, profileScope: { ...scope, accountId: 'other' } }));
        expect(hook.getCurrent()).toBeUndefined();
        await hook.rerender({ enabled: false });
        expect(subscriptions).toBe(0);
        await act(async () => storage.setState({ projectAccountRows: rows, profileScope: scope }));
        const exact = await renderHook(() => useProjectAccountWorkspaceRef('checkout', scope.serverId));
        expect(exact.getCurrent()).toBe(rows.workspaceRefs[0]);
        identityReads = 0;
        await act(async () => storage.setState({ isDataReady: true }));
        // A root notification outside Project rows must not revisit even the exact lookup's candidates.
        expect(identityReads).toBe(0);
        await exact.unmount();
        expect(subscriptions).toBe(0);
    });
});
