import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import type { HappierStorageSummaryV1, MachineStorageCategoryListResultV1, MachineStorageWatchResultV1 } from '@happier-dev/protocol/storage/storageV1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createMachineStorageStore, type MachineStorageStore } from './machineStorageStore';
import { fetchMachineStorageSummaryViaAction, fetchMachineStorageCategoryViaAction, refreshMachineStorageSizeViaAction, watchMachineStorageViaMachineRpc,
    type MachineStorageClients, type MachineStorageWatchInput } from './machineRpc';

const boundary = vi.hoisted(() => ({ execute: vi.fn(), rpc: vi.fn() }));
// These are the external Action and Machine network boundaries. Adapters, parsers,
// domain state and the canonical shared subscription lifecycle remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({ createFrontDoorActionExecute: () => boundary.execute }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));
await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');

const key = { serverId: 'home-a', machineId: 'machine-a', expectedAccountId: 'account-a' };
const summary = (revision = 1): HappierStorageSummaryV1 => ({
    revision, sizedAt: 100, volumes: [], categories: [
        { categoryId: 'logs', size: { allocatedBytes: 20, freesBytes: 10, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false }, canGoBytes: 10, count: 1, detailFacts: {} },
        { categoryId: 'caches', size: { allocatedBytes: 30, freesBytes: 30, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false }, canGoBytes: 30, count: 1, detailFacts: {} },
    ], suggestionsTop: [], pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] },
});
const category = (revision = 1): MachineStorageCategoryListResultV1 => ({ revision, sizedAt: 100, categoryId: 'logs', items: [], nextCursor: 'next-page' });
async function settle() { for (let turn = 0; turn < 16; turn++) await Promise.resolve(); }
const success = (result: unknown) => ({ ok: true, result });
const unavailable = { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' };
const failed = { ok: false, errorCode: 'request_failed', error: 'Request failed' };
const stores: MachineStorageStore[] = [];
function harness() {
    boundary.execute.mockReset(); boundary.rpc.mockReset();
    const watches: { input: Pick<MachineStorageWatchInput, 'signal'>; answer: ReturnType<typeof createDeferred<MachineStorageWatchResultV1>> }[] = [];
    const responses = {
        summary: vi.fn<(input: unknown) => Promise<unknown>>(async () => success(summary())),
        category: vi.fn<(input: unknown) => Promise<unknown>>(async () => success(category())),
        refresh: vi.fn<(input: unknown) => Promise<unknown>>(async () => success(summary(2))),
    };
    boundary.execute.mockImplementation((action: string, input: unknown) => {
        if (action === 'machines.storage.summary.get') return responses.summary(input);
        if (action === 'machines.storage.category.list') return responses.category(input);
        if (action === 'machines.storage.size.refresh') return responses.refresh(input);
        throw new Error(`Unexpected storage Action: ${action}`);
    });
    boundary.rpc.mockImplementation((input: { signal?: AbortSignal }) => {
        const answer = createDeferred<MachineStorageWatchResultV1>();
        watches.push({ input, answer });
        return answer.promise;
    });
    const clients: MachineStorageClients = {
        summaryClient: fetchMachineStorageSummaryViaAction,
        categoryClient: fetchMachineStorageCategoryViaAction,
        refreshClient: refreshMachineStorageSizeViaAction,
        watchClient: watchMachineStorageViaMachineRpc,
    };
    const store = createMachineStorageStore(clients);
    stores.push(store);
    return { responses, watches, store };
}

describe('machine storage subscription owner', () => {
    afterEach(() => { for (const store of stores.splice(0)) store.reset(); vi.useRealTimers(); });
    it('retains daemon per-volume Safe totals and distinguishes an absent total from measured zero', async () => {
        const h = harness();
        const volume = { volume: { volumeId: 'main', label: 'Main', mountPath: '/' }, totalBytes: 1000,
            freeBytes: 500, happierBytes: 100, pileBytes: 0, trashBytes: 0 };
        const reported = { ...summary(), volumes: [{ ...volume, canGoBytes: 10 },
            { ...volume, volume: { ...volume.volume, volumeId: 'secondary', mountPath: '/second' }, canGoBytes: 30 },
            { ...volume, volume: { ...volume.volume, volumeId: 'empty', mountPath: '/empty' }, canGoBytes: 0 },
            { ...volume, volume: { ...volume.volume, volumeId: 'unreported', mountPath: '/unknown' } }] };
        h.responses.summary.mockResolvedValue(success(reported));
        await h.store.read(key);
        expect(h.store.getState(key).summary?.volumes).toEqual(reported.volumes);
        const retained = h.store.getState(key).summary!.volumes[1];
        const release = h.store.demand(key); await settle();
        h.watches[0].answer.resolve({ changed: true, summary: { ...reported, revision: 2,
            volumes: [{ ...reported.volumes[0], canGoBytes: 20 }, ...reported.volumes.slice(1)] } });
        await settle();
        expect(h.store.getState(key).summary?.volumes[0]).toMatchObject({ canGoBytes: 20 });
        expect(h.store.getState(key).summary?.volumes[1]).toBe(retained);
        release();
    });
    it('shares private scan pages and refreshes them on the same revision watch without polling or scope leakage', async () => {
        const h = harness(); await h.store.read(key);
        const input = { ...key, view: { tab: 'old' as const, depth: 1 as const, olderThanDays: 1000 } };
        const page = { state: null, nodes: [], coverage: [], indexedAt: 100 };
        let current = page;
        boundary.execute.mockImplementation((action: string) => Promise.resolve(success(action === 'machines.storage.scan.get' ? current : summary())));
        vi.useFakeTimers();
        const first = h.store.demandScan(input); const second = h.store.demandScan(input);
        await settle();
        expect(h.store.getScan(input)).toEqual({ status: 'ready', page });
        expect(h.store.getScan({ ...input, expectedAccountId: 'other' }).page).toBeNull();
        const retained = h.store.getScan(input).page;
        current = { ...page, indexedAt: 200 };
        h.watches[0].answer.resolve({ changed: true, summary: summary(2) }); await settle();
        expect(h.store.getScan(input).page?.indexedAt).toBe(200);
        expect(h.store.getScan(input).page).not.toBe(retained);
        expect(vi.getTimerCount()).toBe(0);
        first(); expect(h.watches.at(-1)?.input.signal?.aborted).toBe(false);
        second(); expect(h.watches.at(-1)?.input.signal?.aborted).toBe(true);
    });

    it('projects optimistic pile membership and rolls back a rejected delta against current daemon truth', async () => {
        const h = harness();
        await h.store.read(key);
        const ref = { itemId: 'log-1', path: '/fixture/log', identity: { dev: '1', ino: '2', kind: 'file' as const },
            collectedAt: 100, collectedBy: { accountId: 'account-a', kind: 'person' as const } };
        const pending = createDeferred<unknown>();
        boundary.execute.mockImplementation((action: string) => action === 'machines.storage.pile.get'
            ? Promise.resolve(success({ revision: 1, items: [], summary: summary().pile }))
            : action === 'machines.storage.pile.set' ? pending.promise : Promise.resolve(success(summary())));
        await h.store.readPile(key);
        const writing = h.store.setPile({ ...key, add: [ref] });
        expect(h.store.getPile(key)).toMatchObject({ page: { items: [ref], summary: { count: 1 } }, pending: true });
        expect(h.store.getState(key).summary?.pile.count).toBe(1);
        pending.resolve(failed);
        expect(await writing).toEqual({ ok: false, reason: 'request_failed' });
        expect(h.store.getPile(key)).toMatchObject({ page: { items: [], summary: { count: 0 } }, pending: false });
        expect(h.store.getState(key).summary?.pile.count).toBe(0);
    });

    it('shares one watch across summary/category demand, preserves nested identities and aborts final demand without a timer', async () => {
        const h = harness();
        // Establish the report through the real read before several consumers acquire demand.
        await h.store.read(key);
        vi.useFakeTimers();
        const releaseSummary = h.store.demand(key);
        const releaseCategory = h.store.demandCategory({ ...key, categoryId: 'logs' });
        await settle();
        expect(h.store.getState(key).summary?.revision).toBe(1);
        expect(h.store.getCategory({ ...key, categoryId: 'logs' })).toMatchObject({ status: 'ready', page: { nextCursor: 'next-page' } });
        expect(h.watches).toHaveLength(1);
        const before = h.store.getState(key).summary!;
        const next = summary(2); next.categories[0].size.allocatedBytes = 25;
        h.responses.category.mockResolvedValueOnce(success(category(2)));
        h.watches[0].answer.resolve({ changed: true, summary: next });
        await settle();
        const after = h.store.getState(key).summary!;
        expect(after.categories[1]).toBe(before.categories[1]);
        expect(after.pile).toBe(before.pile);
        expect(h.store.getCategory({ ...key, categoryId: 'logs' }).page).toMatchObject({ revision: 2, nextCursor: 'next-page' });
        expect(vi.getTimerCount()).toBe(0);
        releaseSummary(); expect(h.watches.at(-1)?.input.signal?.aborted).toBe(false);
        releaseCategory(); expect(h.watches.at(-1)?.input.signal?.aborted).toBe(true);
        h.store.reset(); vi.useRealTimers();
    });

    it('keeps a pending pile tick visible through a daemon watch and rolls back onto its refreshed membership', async () => {
        const h = harness();
        await h.store.read(key);
        const ref = { itemId: 'log-1', path: '/fixture/log', identity: { dev: '1', ino: '2', kind: 'file' as const },
            collectedAt: 100, collectedBy: { accountId: 'account-a', kind: 'person' as const } };
        const other = { ...ref, itemId: 'log-2', path: '/fixture/other' };
        const pending = createDeferred<unknown>();
        let daemonItems = [other];
        boundary.execute.mockImplementation((action: string) => action === 'machines.storage.pile.get'
            ? Promise.resolve(success({ revision: 2, items: daemonItems,
                summary: { ...summary().pile, count: daemonItems.length } }))
            : action === 'machines.storage.pile.set' ? pending.promise : Promise.resolve(success(summary())));
        const release = h.store.demandPile(key); await settle();
        const writing = h.store.setPile({ ...key, add: [ref] });
        daemonItems = [];
        h.watches[0].answer.resolve({ changed: true, summary: summary(3) }); await settle();
        expect(h.store.getPile(key)).toMatchObject({ page: { items: [ref] }, pending: true });
        expect(h.store.getState(key).summary?.pile.count).toBe(1);
        pending.resolve(failed); await writing;
        expect(h.store.getPile(key)).toMatchObject({ page: { items: [] }, pending: false });
        release();
    });

    it('retains the last report on errors and distinguishes Home and Account scopes', async () => {
        const h = harness();
        await h.store.read(key);
        const good = h.store.getState(key).summary;
        h.responses.summary.mockResolvedValueOnce(failed);
        await h.store.read(key);
        expect(h.store.getState(key)).toMatchObject({ status: 'error', summary: good });
        expect(h.store.getState({ ...key, serverId: 'home-b' }).summary).toBeNull();
        expect(h.store.getState({ ...key, expectedAccountId: 'account-b' }).summary).toBeNull();
        h.store.reset();
    });

    it('ignores aborted reads and old revisions arriving after a watched revision', async () => {
        const h = harness();
        const release = h.store.demand(key); await settle();
        expect(h.watches).toHaveLength(1);
        const slow = createDeferred<unknown>();
        h.responses.summary.mockImplementationOnce(() => slow.promise);
        const pending = h.store.read(key);
        h.watches[0].answer.resolve({ changed: true, summary: summary(3) }); await settle();
        slow.resolve(success(summary(2))); await pending;
        expect(h.store.getState(key).summary?.revision).toBe(3);
        const late = createDeferred<unknown>();
        h.responses.summary.mockImplementationOnce(() => late.promise);
        const cancelled = h.store.read(key); release();
        late.resolve(success(summary(4))); await cancelled;
        expect(h.store.getState(key).summary?.revision).toBe(3);
        h.store.reset();
    });

    it('degrades only unavailable operations and retries after the daemon changes', async () => {
        const h = harness();
        h.responses.summary.mockResolvedValueOnce(unavailable);
        const release = h.store.demand(key); await settle();
        expect(h.store.getState(key).status).toBe('not_reported');
        expect(h.watches).toHaveLength(0);
        h.store.daemonStateChanged(key, 2); await settle();
        expect(h.store.getState(key).status).toBe('ready');
        h.responses.category.mockResolvedValueOnce(unavailable);
        const releaseCategory = h.store.demandCategory({ ...key, categoryId: 'logs' }); await settle();
        expect(h.store.getCategory({ ...key, categoryId: 'logs' }).status).toBe('not_reported');
        expect(h.store.getState(key).status).toBe('ready');
        release(); releaseCategory(); h.store.reset();
    });

    it('keeps older-daemon pile mutation unavailable without hiding its supported summary', async () => {
        const h = harness();
        await h.store.read(key);
        boundary.execute.mockImplementation(async (action: string) => action === 'machines.storage.pile.get' ? unavailable : success(summary()));
        expect(await h.store.setPile({ ...key, clear: true })).toEqual({ ok: false, reason: 'older_happier' });
        expect(h.store.getState(key).status).toBe('ready');
        expect(boundary.execute.mock.calls.some(([action]) => action === 'machines.storage.pile.set')).toBe(false);
    });

    it('sizes explicitly once and publishes the new summary without starting a polling loop', async () => {
        const h = harness();
        await h.store.read(key);
        await h.store.sizeAgain({ ...key, categoryId: 'logs' });
        expect(h.store.getState(key).summary?.revision).toBe(2);
        expect(h.responses.refresh).toHaveBeenCalledWith(expect.objectContaining({ categoryId: 'logs' }));
        expect(h.watches).toHaveLength(0);
        h.store.reset();
    });

    it('does not let a pending Size again response overwrite a newer watched summary', async () => {
        const h = harness();
        const release = h.store.demand(key); await settle();
        const slow = createDeferred<unknown>();
        h.responses.refresh.mockImplementationOnce(() => slow.promise);
        const pending = h.store.sizeAgain(key);
        h.watches[0].answer.resolve({ changed: true, summary: summary(3) }); await settle();
        slow.resolve(success(summary(2))); await pending;
        expect(h.store.getState(key).summary?.revision).toBe(3);
        release(); h.store.reset();
    });

    it('accepts a restarted daemon revision and does not let an obsolete category page win a watch invalidation', async () => {
        const h = harness();
        await h.store.read(key);
        h.responses.summary.mockResolvedValueOnce(success(summary(0)));
        await h.store.read(key);
        expect(h.store.getState(key).summary?.revision).toBe(0);
        const release = h.store.demand(key); await settle();
        const slow = createDeferred<unknown>();
        h.responses.category.mockImplementationOnce(() => slow.promise).mockResolvedValueOnce(success(category(3)));
        const releaseCategory = h.store.demandCategory({ ...key, categoryId: 'logs' });
        h.watches[0].answer.resolve({ changed: true, summary: summary(3) }); await settle();
        slow.resolve(success(category(1))); await settle();
        expect(h.store.getCategory({ ...key, categoryId: 'logs' }).page?.revision).toBe(3);
        releaseCategory(); release(); h.store.reset();
    });
});

describe('machine storage cleanup and item lists', () => {
    afterEach(() => { for (const store of stores.splice(0)) store.reset(); vi.useRealTimers(); });
    const ref = { itemId: 'wt-1', path: '/repo/.dev/worktree/a', identity: { dev: '1', ino: '2', kind: 'directory' as const },
        collectedAt: 1, collectedBy: { accountId: 'account-a', kind: 'person' as const } };
    const item = { itemId: 'wt-1', kind: 'worktree' as const, title: 'a', evidence: [], path: '/repo/.dev/worktree/a',
        size: { allocatedBytes: 5, freesBytes: 5, sharedBytes: 0, sharedExtentsUnmeasured: false, atLeast: false },
        verdict: 'safe' as const, reason: { code: 'merged_clean' as const }, collectable: true };

    it('checks the pile by served reference, never resending the identity the machine resolved', async () => {
        const h = harness();
        await h.store.read(key);
        const calls: Array<[string, unknown]> = [];
        boundary.execute.mockImplementation((action: string, input: unknown) => {
            calls.push([action, input]);
            return Promise.resolve(success(action === 'machines.storage.items.check' ? { items: [], staying: [], countedOnceBytes: 0, totalFreesBytes: 0, trashVolumes: [] } : summary()));
        });
        const resolved = { itemId: 'log-1', path: '/fixture/log', identity: { dev: '1', ino: '2', kind: 'file' as const },
            collectedAt: 100, collectedBy: { accountId: 'account-a', kind: 'person' as const } };
        await h.store.checkPile({ ...key, refs: [resolved] });
        expect((calls.find(([action]) => action === 'machines.storage.items.check')?.[1] as { refs: unknown }).refs).toEqual([{ itemId: 'log-1', path: '/fixture/log' }]);
    });

    it('holds one receipt per machine after a Trash move, puts that batch back on Undo and frees it on Empty now', async () => {
        const h = harness();
        await h.store.read(key);
        const calls: Array<[string, unknown]> = [];
        boundary.execute.mockImplementation((action: string, input: unknown) => {
            calls.push([action, input]);
            if (action === 'machines.storage.trash.move') return Promise.resolve(success({ batchId: 'batch-1', mode: 'trash', inTrashBytes: 5, freedBytes: 0,
                outcomes: [{ itemId: 'wt-1', status: 'moved' }] }));
            if (action === 'machines.storage.trash.restore') return Promise.resolve(success({ outcomes: [{ entryId: 'e1', status: 'restored' }] }));
            if (action === 'machines.storage.trash.empty') return Promise.resolve(success({ outcomes: [{ entryId: 'e1', status: 'deleted' }], freedBytes: 5 }));
            return Promise.resolve(success(summary(calls.length + 1)));
        });
        // A mounted Storage tab holds the summary's demand; the move makes it read the machine again.
        const release = h.store.demand(key); await settle();
        const readsBefore = calls.filter(([action]) => action === 'machines.storage.summary.get').length;
        const moved = await h.store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        expect(moved.ok).toBe(true);
        expect(calls.find(([action]) => action === 'machines.storage.trash.move')?.[1]).toMatchObject({ items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        expect(h.store.getReceipt(key)).toMatchObject({ kind: 'applied', result: { batchId: 'batch-1' } });
        expect(h.store.getReceipt({ ...key, machineId: 'other' })).toBeNull();
        await settle();
        // The summary is read again so the Trash row and the disk's hatch follow the move.
        expect(calls.filter(([action]) => action === 'machines.storage.summary.get').length).toBeGreaterThan(readsBefore);

        expect((await h.store.undoReceipt(key)).ok).toBe(true);
        expect(calls.find(([action]) => action === 'machines.storage.trash.restore')?.[1]).toMatchObject({ batchId: 'batch-1' });
        expect(h.store.getReceipt(key)).toBeNull();

        await h.store.applyPile({ ...key, mode: 'trash', items: [{ ref, expect: 'token', claimedVerdict: 'safe' }] });
        expect((await h.store.emptyReceipt(key)).ok).toBe(true);
        expect(calls.filter(([action]) => action === 'machines.storage.trash.empty').at(-1)?.[1]).toMatchObject({ batchId: 'batch-1' });
        expect(h.store.getReceipt(key)).toEqual({ kind: 'emptied', count: 1, freedBytes: 5 });
        release();
    });

    it('reads Worktrees and Suggestions lists once per filter and again when the storage revision moves', async () => {
        const h = harness();
        await h.store.read(key);
        let listRevision = 1;
        const lists: unknown[] = [];
        boundary.execute.mockImplementation((action: string, input: unknown) => {
            if (action === 'machines.storage.worktrees.list') { lists.push(input); return Promise.resolve(success({ revision: listRevision, items: [item] })); }
            return Promise.resolve(success(summary()));
        });
        const input = { ...key, list: 'worktrees' as const, filter: 'safe' as const };
        const first = h.store.demandItems(input); const second = h.store.demandItems(input);
        await settle();
        expect(h.store.getItems(input)).toMatchObject({ status: 'ready', page: { items: [item] } });
        expect(lists).toHaveLength(1);
        expect(lists[0]).toMatchObject({ filter: 'safe' });
        listRevision = 2;
        h.watches[0]!.answer.resolve({ changed: true, summary: summary(2) }); await settle();
        expect(lists).toHaveLength(2);
        expect(h.store.getItems(input).page?.revision).toBe(2);
        first(); second();
    });

    it('prepares the low-disk pile from the quickest Safe items for the named disk, through the ordinary collect Action', async () => {
        const h = harness();
        await h.store.read(key);
        const calls: Array<[string, Record<string, unknown>]> = [];
        const quickest = [
            { ...item, itemId: 'a', path: '/data/a' },
            { ...item, itemId: 'b', path: '/data/b', verdict: 'caution' as const },
            { ...item, itemId: 'c', path: '/data/c', collectable: false },
        ];
        boundary.execute.mockImplementation((action: string, input: Record<string, unknown>) => {
            calls.push([action, input]);
            if (action === 'machines.storage.suggestions.list') return Promise.resolve(success({ revision: 1, items: quickest }));
            if (action === 'machines.storage.pile.get') return Promise.resolve(success({ revision: 1, items: [], summary: summary().pile }));
            if (action === 'machines.storage.pile.set') return Promise.resolve(success({ revision: 2, items: [], summary: summary().pile }));
            return Promise.resolve(success(summary()));
        });
        expect(await h.store.prepareLowDisk({ ...key, volumeId: 'data' })).toBe(1);
        expect(calls.find(([action]) => action === 'machines.storage.suggestions.list')?.[1]).toMatchObject({ quickestForVolume: 'data' });
        const sets = calls.filter(([action]) => action === 'machines.storage.pile.set');
        expect(sets).toHaveLength(1);
        // Served references only: the machine reads identity and records who collected it (no placeholder facts).
        expect(sets[0]![1].add).toEqual([{ itemId: 'a', path: '/data/a' }]);
        boundary.execute.mockImplementation((action: string, input: Record<string, unknown>) => {
            calls.push([action, input]);
            return Promise.resolve(success(action === 'machines.storage.suggestions.list' ? { revision: 1, items: [quickest[1]] } : summary()));
        });
        expect(await h.store.prepareLowDisk({ ...key, volumeId: 'data' })).toBe(0);
        expect(calls.filter(([action]) => action === 'machines.storage.pile.set')).toHaveLength(1);
    });
});
