import type { HappierStorageSummaryV1, MachineStorageCategoryListResultV1, MachineStoragePileResultV1, StorageItemRefV1, MachineStorageScanGetResultV1, DiskScanStateV1,
    MachineStorageItemsListResultV1, PileApplyResultV1, PileReviewV1, TrashEmptyResultV1, TrashRestoreResultV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineResourcesPolicyMutationResultV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import type { MachineStorageClients, MachineStorageKey, MachineStorageCategoryInput, MachineStorageRefreshInput, MachineStoragePileSetInput, MachineStorageResult } from './machineRpc';
import type { MachineStorageScanInput, MachineStorageScanStartInput, MachineStorageScanCancelInput, MachineStorageScanSkipInput,
    MachineStorageItemsInput, MachineStorageCheckInput, MachineStorageApplyInput, MachineStorageTrashEmptyInput, MachineStorageTrashRestoreInput, MachineStorageReadInput } from './machineRpc';
import { createSharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { toStorageItemRef } from './pileRef';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type MachineStorageState = Readonly<{ status: 'loading' | 'ready' | 'error' | 'not_reported'; summary: HappierStorageSummaryV1 | null }>;
export type MachineStorageCategoryState = Readonly<{ status: MachineStorageState['status']; page: MachineStorageCategoryListResultV1 | null }>;
/**
 * The pile as rows read it: the machine's own refs (identity and who collected each, daemon-resolved) plus
 * any delta still on its way, which carries only the served reference until the machine answers.
 */
export type MachineStoragePileView = Omit<MachineStoragePileResultV1, 'items'> & Readonly<{ items: readonly Readonly<StorageItemRefV1>[] }>;
export type MachineStoragePileState = Readonly<{ status: MachineStorageState['status']; page: MachineStoragePileView | null; pending: boolean }>;
export type MachineStorageScanState = Readonly<{ status: MachineStorageState['status']; page: MachineStorageScanGetResultV1 | null }>;
export type MachineStorageItemsState = Readonly<{ status: MachineStorageState['status']; page: MachineStorageItemsListResultV1 | null }>;
/** What the last review-sheet action did on this machine, kept until dismissed (the pile bar's result). */
export type MachineStorageReceipt =
    | Readonly<{ kind: 'applied'; result: PileApplyResultV1; at: number; paths: Readonly<Record<string, string>> }>
    | Readonly<{ kind: 'emptied'; count: number; freedBytes: number }>;
const EMPTY: MachineStorageState = { status: 'loading', summary: null };
const EMPTY_CATEGORY: MachineStorageCategoryState = { status: 'loading', page: null };
const EMPTY_PILE: MachineStoragePileState = { status: 'loading', page: null, pending: false };
const EMPTY_SCAN: MachineStorageScanState = { status: 'loading', page: null };
const EMPTY_ITEMS: MachineStorageItemsState = { status: 'loading', page: null };

function machineKey(input: MachineStorageKey): string { return JSON.stringify([input.serverId ?? null, input.expectedAccountId ?? null, input.machineId]); }
function categoryKey(input: MachineStorageCategoryInput): string { return JSON.stringify([machineKey(input), input.categoryId, input.cursor ?? null]); }
function scanKey(input: MachineStorageScanInput): string { return JSON.stringify([machineKey(input), input.scanId ?? null, input.view ?? null]); }
function itemsKey(input: MachineStorageItemsInput): string {
    return JSON.stringify([machineKey(input), input.list, input.projectId ?? null, input.filter ?? null, input.group ?? null, input.quickestForVolume ?? null]);
}
function retain<T>(previous: T | undefined, incoming: T): T { return sameStrictJsonValue(previous, incoming) ? previous! : incoming; }
function reconcileSummary(previous: HappierStorageSummaryV1 | null, incoming: HappierStorageSummaryV1): HappierStorageSummaryV1 {
    if (!previous) return incoming;
    const oldCategories = new Map(previous.categories.map(category => [category.categoryId, category]));
    const oldVolumes = new Map(previous.volumes.map(volume => [volume.volume.volumeId, volume]));
    return retain(previous, {
        ...incoming,
        categories: retain(previous.categories, incoming.categories.map(category => retain(oldCategories.get(category.categoryId), category)!)),
        volumes: retain(previous.volumes, incoming.volumes.map(volume => retain(oldVolumes.get(volume.volume.volumeId), volume)!)),
        suggestionsTop: retain(previous.suggestionsTop, incoming.suggestionsTop),
        pile: retain(previous.pile, incoming.pile), trash: retain(previous.trash, incoming.trash), wholeDisk: retain(previous.wholeDisk, incoming.wholeDisk),
    });
}
type Update = Readonly<{ kind: 'summary'; summary: HappierStorageSummaryV1 }> | Readonly<{ kind: 'error' | 'not_reported' }>;

export function createMachineStorageStore(clients: MachineStorageClients) {
    const categoryDemands = new Map<string, { input: MachineStorageCategoryInput; count: number }>();
    const daemonVersions = new Map<string, number | null | undefined>();
    const pileDemands = new Map<string, { input: MachineStorageKey; count: number }>();
    const scanDemands = new Map<string, { input: MachineStorageScanInput; count: number }>();
    const itemDemands = new Map<string, { input: MachineStorageItemsInput; count: number }>();
    const receipts = new Map<string, MachineStorageReceipt>();
    const receiptListeners = new Map<string, Set<() => void>>();
    type PileWrite = { input: MachineStoragePileSetInput };
    type PileWriteQueue = { base: MachineStoragePileView; writes: PileWrite[]; tail: Promise<void> };
    const pileWrites = new Map<string, PileWriteQueue>();
    const projectPile = (input: MachineStorageKey, base: MachineStoragePileView): MachineStoragePileView => {
        const writes = pileWrites.get(machineKey(input))?.writes;
        if (!writes?.length) return base;
        let items = base.items;
        for (const { input: delta } of writes) {
            const byId = new Map<string, Readonly<StorageItemRefV1>>((delta.clear ? [] : items).map(item => [item.itemId, item]));
            for (const itemId of delta.remove ?? []) byId.delete(itemId);
            for (const ref of delta.add ?? []) byId.set(ref.itemId, ref);
            items = [...byId.values()];
        }
        // Membership is optimistic; byte reclamation remains the daemon's measured fact.
        return { ...base, items, summary: { ...base.summary, count: items.length } };
    };
    const apply = (state: MachineStorageState, update: Update): MachineStorageState => update.kind === 'summary'
        ? retain(state, { status: 'ready', summary: reconcileSummary(state.summary, update.summary) })
        : retain(state, { ...state, status: update.kind });
    const refreshCategories = (input: MachineStorageKey) => {
        for (const entry of categoryDemands.values()) if (machineKey(entry.input) === machineKey(input)) categories.invalidate(entry.input);
        if (pileDemands.has(machineKey(input))) piles.invalidate(input);
        for (const entry of scanDemands.values()) if (machineKey(entry.input) === machineKey(input)) scans.invalidate(entry.input);
        for (const entry of itemDemands.values()) if (machineKey(entry.input) === machineKey(input)) itemLists.invalidate(entry.input);
    };
    const acceptSummary = (input: MachineStorageKey, incoming: HappierStorageSummaryV1) => {
        const previous = summaries.getState(input).summary;
        summaries.publish(input, { kind: 'summary', summary: overlaySummary(input, incoming) });
        if (previous?.revision !== incoming.revision) refreshCategories(input);
    };
    const overlaySummary = (input: MachineStorageKey, incoming: HappierStorageSummaryV1) => {
        const queue = pileWrites.get(machineKey(input));
        return queue?.writes.length ? { ...incoming, pile: { ...incoming.pile,
            count: projectPile(input, queue.base).items.length } } : incoming;
    };
    const summaries = createSharedSubscriptionStore<MachineStorageKey, MachineStorageState, Update, MachineStorageClients['summaryClient'], MachineStorageClients['watchClient']>({
        emptyState: EMPTY, createState: () => EMPTY,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null }),
        storeKey: machineKey, defaultSnapshotClient: clients.summaryClient, defaultWatchClient: clients.watchClient,
        retainState: true, watchAfterRefresh: true, shouldWatch: state => state.status === 'ready',
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineStorageState> => {
            const result = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = summaries.getState(input);
            if (!result.ok) return apply(current, { kind: result.reason === 'older_happier' ? 'not_reported' : 'error' });
            // Only a newer answer received during this request can supersede it. A new daemon may
            // start its revision at zero, so retained revisions are not a connection-wide floor.
            if (current.summary !== state.summary && current.summary && result.value.revision <= current.summary.revision) return current;
            if (current.summary?.revision !== result.value.revision) refreshCategories(input);
            return apply(current, { kind: 'summary', summary: overlaySummary(input, result.value) });
        },
        failRefresh: state => apply(state, { kind: 'error' }), applySnapshot: apply,
        onWatchSnapshot: (input, update, previous) => {
            if (update.kind === 'summary' && previous.summary?.revision !== update.summary.revision) refreshCategories(input);
        },
        watch: async ({ input, state, watchClient, signal }) => {
            const result = await watchClient({ ...input, sinceRevision: state.summary?.revision, signal });
            if (signal?.aborted) return { status: 'unavailable' };
            if (!result.ok) {
                summaries.publish(input, { kind: result.reason === 'older_happier' ? 'not_reported' : 'error' });
                return { status: 'unavailable' };
            }
            if (!result.value.changed) return { status: 'idle' };
            const current = summaries.getState(input);
            if (current.summary !== state.summary && current.summary && result.value.summary.revision < current.summary.revision) return { status: 'idle' };
            return { status: 'changed', snapshot: { kind: 'summary', summary: overlaySummary(input, result.value.summary) } };
        },
    });
    const categories = createSharedSubscriptionStore<MachineStorageCategoryInput, MachineStorageCategoryState, MachineStorageCategoryListResultV1, MachineStorageClients['categoryClient']>({
        emptyState: EMPTY_CATEGORY, createState: () => EMPTY_CATEGORY,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null }),
        storeKey: categoryKey, defaultSnapshotClient: clients.categoryClient, retainState: true,
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineStorageCategoryState> => {
            const result = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = categories.getState(input);
            if (!result.ok) return retain(current, { ...current, status: result.reason === 'older_happier' ? 'not_reported' : 'error' });
            if (result.value.categoryId !== input.categoryId) return retain(current, { ...current, status: 'error' });
            const previousItems = new Map(current.page?.items.map(item => [item.itemId, item]));
            const page = current.page ? retain(current.page, { ...result.value,
                items: retain(current.page.items, result.value.items.map(item => retain(previousItems.get(item.itemId), item)!)),
            }) : result.value;
            return retain(current, { status: 'ready', page });
        },
        failRefresh: state => retain(state, { ...state, status: 'error' }),
        applySnapshot: (state, page) => retain(state, { status: 'ready', page: retain(state.page, page) }),
    });
    const pileClient = clients.pileClient ?? (async input => (await import('./machineRpc')).fetchMachineStoragePileViaAction(input));
    const pileSetClient = clients.pileSetClient ?? (async input => (await import('./machineRpc')).setMachineStoragePileViaAction(input));
    const piles = createSharedSubscriptionStore<MachineStorageKey, MachineStoragePileState, MachineStoragePileState, typeof pileClient>({
        emptyState: EMPTY_PILE, createState: () => EMPTY_PILE,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null }),
        storeKey: machineKey, defaultSnapshotClient: pileClient, retainState: true,
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineStoragePileState> => {
            const response = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = piles.getState(input);
            if (!response.ok) return retain(current, { ...current, status: response.reason === 'older_happier' ? 'not_reported' : 'error' });
            const queue = pileWrites.get(machineKey(input));
            if (queue) queue.base = response.value;
            const page = projectPile(input, response.value);
            const report = summaries.getState(input).summary;
            if (report) summaries.publish(input, { kind: 'summary', summary: { ...report, pile: page.summary } });
            return retain(current, { status: 'ready', page: retain(current.page, page), pending: !!queue?.writes.length });
        },
        failRefresh: state => retain(state, { ...state, status: 'error' }), applySnapshot: (_state, update) => update,
    });
    const publishPile = (input: MachineStorageKey, base: MachineStoragePileView) => {
        const page = projectPile(input, base);
        const current = piles.getState(input);
        piles.publish(input, retain(current, { status: 'ready', page: retain(current.page, page), pending: !!pileWrites.get(machineKey(input))?.writes.length }));
        const report = summaries.getState(input).summary;
        if (report) summaries.publish(input, { kind: 'summary', summary: { ...report, pile: page.summary } });
    };
    const scanClient = clients.scanClient ?? (async input => (await import('./machineRpc')).fetchMachineStorageScanViaAction(input));
    const scans = createSharedSubscriptionStore<MachineStorageScanInput, MachineStorageScanState, MachineStorageScanGetResultV1, typeof scanClient>({
        emptyState: EMPTY_SCAN, createState: () => EMPTY_SCAN, storeKey: scanKey, defaultSnapshotClient: scanClient, retainState: true,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null }),
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineStorageScanState> => {
            const response = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = scans.getState(input);
            return response.ok ? retain(current, { status: 'ready', page: retain(current.page, response.value) })
                : retain(current, { ...current, status: response.reason === 'older_happier' ? 'not_reported' : 'error' });
        },
        failRefresh: state => retain(state, { ...state, status: 'error' }),
        applySnapshot: (state, page) => retain(state, { status: 'ready', page: retain(state.page, page) }),
    });
    const itemsClient = clients.itemsClient ?? (async (input: MachineStorageItemsInput) => (await import('./machineRpc')).fetchMachineStorageItemsViaAction(input));
    const itemLists = createSharedSubscriptionStore<MachineStorageItemsInput, MachineStorageItemsState, MachineStorageItemsListResultV1, typeof itemsClient>({
        emptyState: EMPTY_ITEMS, createState: () => EMPTY_ITEMS, storeKey: itemsKey, defaultSnapshotClient: itemsClient, retainState: true,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null, expectedAccountId: input.expectedAccountId ?? null }),
        refresh: async ({ input, state, snapshotClient, signal }): Promise<MachineStorageItemsState> => {
            const response = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = itemLists.getState(input);
            if (!response.ok) return retain(current, { ...current, status: response.reason === 'older_happier' ? 'not_reported' : 'error' });
            const previous = new Map(current.page?.items.map(item => [item.itemId, item]));
            const page = current.page ? retain(current.page, { ...response.value,
                items: retain(current.page.items, response.value.items.map(item => retain(previous.get(item.itemId), item)!)) }) : response.value;
            return retain(current, { status: 'ready', page });
        },
        failRefresh: state => retain(state, { ...state, status: 'error' }),
        applySnapshot: (state, page) => retain(state, { status: 'ready', page: retain(state.page, page) }),
    });
    const notifyReceipt = (input: MachineStorageKey) => { for (const listener of receiptListeners.get(machineKey(input)) ?? []) listener(); };
    const setReceipt = (input: MachineStorageKey, receipt: MachineStorageReceipt | null) => {
        if (receipt) receipts.set(machineKey(input), receipt); else receipts.delete(machineKey(input));
        notifyReceipt(input);
    };
    /** After anything moved: the summary, the open pages, the lists and the pile all read the machine again. */
    const afterEffect = (input: MachineStorageKey) => { summaries.invalidate(input); refreshCategories(input); piles.invalidate(input); };
    async function effect<I extends MachineStorageKey, T>(input: I, invoke: (input: I) => Promise<MachineStorageResult<T>>) {
        const response = await invoke(input);
        if (response.ok) afterEffect(input);
        return response;
    }
    const rpc = () => import('./machineRpc');
    async function setPile(input: MachineStoragePileSetInput): Promise<MachineStorageResult<MachineStoragePileResultV1>> {
        const key = machineKey(input);
        if (!piles.getState(input).page) await piles.read(input);
        const page = piles.getState(input).page;
        if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
        if (!page) return { ok: false, reason: piles.getState(input).status === 'not_reported' ? 'older_happier' : 'request_failed' };
        const queue: PileWriteQueue = pileWrites.get(key) ?? { base: page, writes: [], tail: Promise.resolve() };
        const write: PileWrite = { input };
        queue.writes.push(write); pileWrites.set(key, queue); publishPile(input, queue.base);
        const pending = queue.tail.then(() => pileSetClient(input));
        queue.tail = pending.then(() => {}, () => {});
        let response: MachineStorageResult<MachineStoragePileResultV1>;
        try { response = await pending; } catch { response = { ok: false, reason: 'request_failed' }; }
        if (pileWrites.get(key) !== queue) return response;
        queue.writes.splice(queue.writes.indexOf(write), 1);
        if (response.ok) queue.base = response.value;
        publishPile(input, queue.base);
        if (!queue.writes.length) pileWrites.delete(key);
        summaries.invalidate(input);
        return response;
    }
    const restoreTrash = (input: MachineStorageTrashRestoreInput): Promise<MachineStorageResult<TrashRestoreResultV1>> =>
        effect(input, clients.trashRestoreClient ?? (async value => (await rpc()).restoreMachineStorageTrashViaAction(value)));
    const emptyTrash = (input: MachineStorageTrashEmptyInput): Promise<MachineStorageResult<TrashEmptyResultV1>> =>
        effect(input, clients.trashEmptyClient ?? (async value => (await rpc()).emptyMachineStorageTrashViaAction(value)));
    async function scanEffect<I extends MachineStorageKey>(input: I, invoke: (input: I) => Promise<MachineStorageResult<DiskScanStateV1>>) {
        const response = await invoke(input);
        if (response.ok) {
            // The Action answer is already an authorized scan state. Do not make the mounted view
            // wait for the next summary/watch round trip to discover the scan it just started.
            summaries.invalidate(input);
            const summary = summaries.getState(input).summary;
            if (summary) summaries.publish(input, { kind: 'summary', summary: { ...summary,
                wholeDisk: { ...summary.wholeDisk, scans: [...summary.wholeDisk.scans.filter(scan => scan.scanId !== response.value.scanId), response.value] } } });
            refreshCategories(input);
        }
        return response;
    }
    return {
        getState: summaries.getState, observe: summaries.observe, getCategory: categories.getState, observeCategory: categories.observe,
        demand(input: MachineStorageKey, listener: () => void = () => {}) { return summaries.subscribe(input, listener); },
        demandCategory(input: MachineStorageCategoryInput, listener: () => void = () => {}) {
            const key = categoryKey(input);
            const entry = categoryDemands.get(key) ?? { input, count: 0 }; entry.count += 1; categoryDemands.set(key, entry);
            const releaseSummary = summaries.subscribe(input, () => {});
            const releaseCategory = categories.subscribe(input, listener);
            let active = true;
            return () => {
                if (!active) return; active = false;
                releaseCategory(); releaseSummary();
                entry.count -= 1; if (entry.count === 0) categoryDemands.delete(key);
            };
        },
        read: summaries.read, readCategory: categories.read,
        getScan: scans.getState, observeScan: scans.observe, readScan: scans.read,
        demandScan(input: MachineStorageScanInput, listener: () => void = () => {}) {
            const key = scanKey(input);
            const entry = scanDemands.get(key) ?? { input, count: 0 }; entry.count++; scanDemands.set(key, entry);
            const releaseSummary = summaries.subscribe(input, () => {});
            const releaseScan = scans.subscribe(input, listener);
            let active = true;
            return () => { if (!active) return; active = false; releaseScan(); releaseSummary();
                if (--entry.count === 0) scanDemands.delete(key); };
        },
        retryScan(input: MachineStorageScanInput) { scans.invalidate(input); summaries.invalidate(input); },
        startScan(input: MachineStorageScanStartInput) { return scanEffect(input, clients.scanStartClient
            ?? (async value => (await import('./machineRpc')).startMachineStorageScanViaAction(value))); },
        cancelScan(input: MachineStorageScanCancelInput) { return scanEffect(input, clients.scanCancelClient
            ?? (async value => (await import('./machineRpc')).cancelMachineStorageScanViaAction(value))); },
        skipScan(input: MachineStorageScanSkipInput) { return scanEffect(input, clients.scanSkipClient
            ?? (async value => (await import('./machineRpc')).skipMachineStorageScanPathViaAction(value))); },
        getPile: piles.getState, observePile: piles.observe, readPile: piles.read,
        demandPile(input: MachineStorageKey, listener: () => void = () => {}) {
            const key = machineKey(input);
            const entry = pileDemands.get(key) ?? { input, count: 0 }; entry.count += 1; pileDemands.set(key, entry);
            const releaseSummary = summaries.subscribe(input, () => {});
            const releasePile = piles.subscribe(input, listener);
            let active = true;
            return () => { if (!active) return; active = false; releaseSummary(); releasePile();
                entry.count -= 1; if (entry.count === 0) pileDemands.delete(key); };
        },
        setPile,
        getItems: itemLists.getState, observeItems: itemLists.observe,
        demandItems(input: MachineStorageItemsInput, listener: () => void = () => {}) {
            const key = itemsKey(input);
            const entry = itemDemands.get(key) ?? { input, count: 0 }; entry.count++; itemDemands.set(key, entry);
            const releaseSummary = summaries.subscribe(input, () => {});
            const releaseItems = itemLists.subscribe(input, listener);
            let active = true;
            return () => { if (!active) return; active = false; releaseItems(); releaseSummary();
                if (--entry.count === 0) itemDemands.delete(key); };
        },
        retryItems(input: MachineStorageItemsInput) { itemLists.invalidate(input); summaries.invalidate(input); },
        /** The review sheet's fresh check of the pile on the machine (`machines.storage.items.check`). */
        async checkPile(input: MachineStorageCheckInput): Promise<MachineStorageResult<PileReviewV1>> {
            // Served references only: the machine re-reads identity itself (the pile's own refs carry more).
            return (clients.checkClient ?? (async value => (await rpc()).checkMachineStorageItemsViaAction(value)))({ ...input, refs: input.refs.map(toStorageItemRef) });
        },
        /** Move to Trash or Delete now, exactly the reviewed items the person kept ticked; the result is the machine's receipt. */
        async applyPile(input: MachineStorageApplyInput): Promise<MachineStorageResult<PileApplyResultV1>> {
            // Review selects exact operands; the Action's policy owns confirmation.
            const { mode, items, ...rest } = input;
            const response = mode === 'trash'
                ? await (clients.trashMoveClient ?? (async value => (await rpc()).moveMachineStorageToTrashViaAction(value)))({ ...rest, items: items.map(item => ({ ...item, claimedVerdict: item.claimedVerdict ?? 'safe' })) })
                : await (clients.deleteNowClient ?? (async value => (await rpc()).deleteMachineStorageNowViaAction(value)))({ ...rest, items: items.map(item => ({ ref: item.ref, expect: item.expect })) });
            if (response.ok) { setReceipt(input, { kind: 'applied', result: response.value, at: Date.now(), paths: Object.fromEntries(items.map(item => [item.ref.itemId, item.ref.path])) }); afterEffect(input); }
            return response;
        },
        /**
         * The low-disk moment's preparation (STO-23), run from the person's tap on "Free up space": the
         * quickest items the machine verified for that disk, Safe and collectable, go in the pile through
         * the ordinary `pile.set`. Returns how many were added.
         */
        async prepareLowDisk(input: MachineStorageKey & Readonly<{ volumeId: string }>): Promise<number> {
            const { volumeId, ...target } = input;
            const listed = await itemsClient({ ...target, list: 'suggestions', quickestForVolume: volumeId });
            if (!listed.ok) return 0;
            const add = listed.value.items.filter(item => item.verdict === 'safe' && item.collectable).map(toStorageItemRef);
            if (add.length === 0) return 0;
            const result = await setPile({ ...target, add });
            return result.ok ? add.length : 0;
        },
        getReceipt(input: MachineStorageKey): MachineStorageReceipt | null { return receipts.get(machineKey(input)) ?? null; },
        observeReceipt(input: MachineStorageKey, listener: () => void) {
            const key = machineKey(input);
            const set = receiptListeners.get(key) ?? new Set(); set.add(listener); receiptListeners.set(key, set);
            return () => { set.delete(listener); if (set.size === 0) receiptListeners.delete(key); };
        },
        dismissReceipt(input: MachineStorageKey) { setReceipt(input, null); },
        /** Undo on the result: Put back that batch. */
        async undoReceipt(input: MachineStorageKey): Promise<MachineStorageResult<TrashRestoreResultV1>> {
            const receipt = receipts.get(machineKey(input));
            if (receipt?.kind !== 'applied' || receipt.result.mode !== 'trash') return { ok: false, reason: 'request_failed' };
            const response = await restoreTrash({ ...input, batchId: receipt.result.batchId });
            if (response.ok && receipts.get(machineKey(input)) === receipt) setReceipt(input, null);
            return response;
        },
        /** Empty now on the result: delete that batch from the Trash; the space is back. */
        async emptyReceipt(input: MachineStorageReadInput): Promise<MachineStorageResult<TrashEmptyResultV1>> {
            const receipt = receipts.get(machineKey(input));
            if (receipt?.kind !== 'applied' || receipt.result.mode !== 'trash') return { ok: false, reason: 'request_failed' };
            const response = await emptyTrash({ ...input, batchId: receipt.result.batchId });
            if (response.ok && receipts.get(machineKey(input)) === receipt) {
                setReceipt(input, { kind: 'emptied', count: response.value.outcomes.filter(outcome => outcome.status === 'deleted').length, freedBytes: response.value.freedBytes });
            }
            return response;
        },
        restoreTrash, emptyTrash,
        /** Protected folders are the machine's resources policy; the policy store re-reads the metadata, storage re-reads its tiers. */
        setProtectedFolder(input: MachineStorageKey & Readonly<{ path: string; protect: boolean }>): Promise<MachineStorageResult<MachineResourcesPolicyMutationResultV1>> {
            const { protect, ...rest } = input;
            return effect(rest, async value => protect ? (await rpc()).addMachineStorageProtectedFolderViaAction(value) : (await rpc()).removeMachineStorageProtectedFolderViaAction(value));
        },
        retry(input: MachineStorageKey) { summaries.invalidate(input); },
        retryCategory(input: MachineStorageCategoryInput) { categories.invalidate(input); summaries.invalidate(input); },
        async sizeAgain(input: MachineStorageRefreshInput): Promise<MachineStorageState> {
            const previous = summaries.getState(input).summary;
            const result = await clients.refreshClient(input);
            if (!input.signal?.aborted) {
                const current = summaries.getState(input).summary;
                if (result.ok) {
                    if (!(current !== previous && current && result.value.revision < current.revision)) acceptSummary(input, result.value);
                } else summaries.publish(input, { kind: result.reason === 'older_happier' ? 'not_reported' : 'error' });
            }
            return summaries.getState(input);
        },
        daemonStateChanged(input: MachineStorageKey, version: number | null | undefined) {
            const key = machineKey(input);
            if (daemonVersions.has(key) && daemonVersions.get(key) === version) return;
            daemonVersions.set(key, version);
            if (summaries.getState(input).status === 'not_reported' || summaries.getState(input).status === 'error') summaries.invalidate(input);
            for (const entry of categoryDemands.values()) if (machineKey(entry.input) === key && categories.getState(entry.input).status !== 'ready') categories.invalidate(entry.input);
            for (const entry of scanDemands.values()) if (machineKey(entry.input) === key && scans.getState(entry.input).status !== 'ready') scans.invalidate(entry.input);
        },
        reset() { summaries.reset(); categories.reset(); piles.reset(); scans.reset(); itemLists.reset(); categoryDemands.clear(); pileDemands.clear(); scanDemands.clear(); itemDemands.clear(); pileWrites.clear(); daemonVersions.clear(); receipts.clear(); receiptListeners.clear(); },
    };
}

export type MachineStorageStore = ReturnType<typeof createMachineStorageStore>;
export const machineStorageStore = createMachineStorageStore({
    summaryClient: async input => (await import('./machineRpc')).fetchMachineStorageSummaryViaAction(input),
    categoryClient: async input => (await import('./machineRpc')).fetchMachineStorageCategoryViaAction(input),
    refreshClient: async input => (await import('./machineRpc')).refreshMachineStorageSizeViaAction(input),
    watchClient: async input => (await import('./machineRpc')).watchMachineStorageViaMachineRpc(input),
});
