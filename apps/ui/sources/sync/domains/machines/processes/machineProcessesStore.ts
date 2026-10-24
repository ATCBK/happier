import { MACHINE_PROCESS_HISTORY_WINDOW_MS, type MachineProcessesAnswerV1, type MachineProcessesWatchResultV1, type OwnerRowV1, type ProcessRowV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { createSharedSubscriptionStore, type SharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import type { MachineProcessesKey, MachineProcessesReadInput, MachineProcessesWatchInput, MachineProcessesRpcResult } from './machineProcessesRpc';

export type MachineProcessesState = Readonly<{ status: 'loading' | 'ready' | 'error' | 'not_supported' | 'unavailable';
    answer: MachineProcessesAnswerV1 | null; reason?: MachineProcessesAnswerV1['reason'] | 'older_happier' | 'request_failed' | 'invalid_response' }>;
export type MachineProcessesClients = Readonly<{
    snapshotClient(input: MachineProcessesReadInput): Promise<MachineProcessesRpcResult<MachineProcessesAnswerV1>>;
    watchClient(input: MachineProcessesWatchInput): Promise<MachineProcessesRpcResult<MachineProcessesWatchResultV1>>;
}>;
export const EMPTY_MACHINE_PROCESSES_STATE: MachineProcessesState = { status: 'loading', answer: null };
type ProcessUpdate = Readonly<{ kind: 'answer'; answer: MachineProcessesAnswerV1 }> | Readonly<{ kind: 'failure'; reason: 'older_happier' | 'request_failed' | 'invalid_response' }>;
function retain<T>(old: T, next: T): T { return JSON.stringify(old) === JSON.stringify(next) ? old : next; }
function retainRows<T extends ProcessRowV1>(old: T[], next: T[]): T[] {
    const byRef = new Map(old.map(row => [row.ref, row]));
    return retain(old, next.map(row => { const existing = byRef.get(row.ref); return existing ? retain(existing, row) : row; }));
}
type ProcessHistory = NonNullable<MachineProcessesAnswerV1['history']>;
/** The newest sample the client holds across every series: the cursor the daemon answers a delta against. */
function newestHistorySample(history: ProcessHistory | undefined): number | undefined {
    let newest: number | undefined;
    for (const samples of Object.values(history ?? {})) {
        const last = samples.at(-1)?.capturedAtMs;
        if (last !== undefined && (newest === undefined || last > newest)) newest = last;
    }
    return newest;
}
/**
 * Joins a delta answered against the held series. Series the delta does not list are gone; series
 * with nothing new keep their array, so an idle tick neither copies nor re-renders a chart.
 */
function mergeHistory(held: ProcessHistory | undefined, delta: ProcessHistory | undefined): ProcessHistory | undefined {
    if (!delta) return undefined;
    const newest = newestHistorySample(delta);
    const cutoff = newest === undefined ? undefined : newest - MACHINE_PROCESS_HISTORY_WINDOW_MS;
    const merged: ProcessHistory = {};
    let changed = Object.keys(delta).length !== Object.keys(held ?? {}).length;
    for (const [ref, added] of Object.entries(delta)) {
        const old = held?.[ref];
        if (old && !added.length && (cutoff === undefined || !old.length || old[0].capturedAtMs >= cutoff)) { merged[ref] = old; continue; }
        const joined = old ? [...old, ...added] : added;
        const first = cutoff === undefined ? 0 : joined.findIndex(sample => sample.capturedAtMs >= cutoff);
        merged[ref] = first < 0 ? [] : first === 0 ? joined : joined.slice(first);
        changed = true;
    }
    return changed ? merged : held;
}
function reconcile(previous: MachineProcessesAnswerV1 | null, answer: MachineProcessesAnswerV1): MachineProcessesAnswerV1 {
    if (!previous) return answer;
    // History is compared by identity (mergeHistory reuses unchanged series); never serialised per arrival.
    const { history: previousHistory, ...previousBare } = previous;
    const { history, ...bare } = answer;
    const byId = new Map(previous.owners.map(owner => [owner.rowId, owner]));
    const owners = answer.owners.map(owner => {
        const old = byId.get(owner.rowId);
        return old ? retain(old, { ...owner, members: retainRows(old.members, owner.members), totals: retain(old.totals, owner.totals) } satisfies OwnerRowV1) : owner;
    });
    const settled = retain(previousBare, { ...bare, owners: retain(previous.owners, owners), leftBehind: retainRows(previous.leftBehind, answer.leftBehind),
        totals: retain(previous.totals, answer.totals),
        ...(answer.notHappier ? { notHappier: retain(previous.notHappier, answer.notHappier) } : {}) });
    return settled === previousBare && history === previousHistory ? previous : { ...settled, ...(history ? { history } : {}) };
}
function settle(state: MachineProcessesState, next: MachineProcessesState): MachineProcessesState {
    return state.status === next.status && state.reason === next.reason && state.answer === next.answer ? state : next;
}
function adopt(state: MachineProcessesState, answer: MachineProcessesAnswerV1): MachineProcessesState {
    if (state.answer && state.answer.capturedAtMs > answer.capturedAtMs) return state;
    if (answer.state === 'unavailable') return settle(state, { status: 'unavailable', reason: answer.reason,
        answer: state.answer?.state === 'live' ? state.answer : retain(state.answer, answer) });
    return settle(state, { status: 'ready', answer: reconcile(state.answer, answer) });
}
function apply(state: MachineProcessesState, update: ProcessUpdate): MachineProcessesState {
    return update.kind === 'answer' ? adopt(state, update.answer)
        : settle(state, { ...state, reason: update.reason, status: update.reason === 'older_happier' ? 'not_supported' : 'error' });
}
export function createMachineProcessesStore(clients: MachineProcessesClients) {
    const storeKey = (input: MachineProcessesKey) => JSON.stringify([input.serverId ?? null, input.accountId ?? null, input.machineId, input.scope, input.view, input.detailToken ?? null]);
    const daemonVersions = new Map<string, number>();
    const store: SharedSubscriptionStore<MachineProcessesKey, MachineProcessesState, ProcessUpdate, MachineProcessesClients['snapshotClient'], MachineProcessesClients['watchClient']> = createSharedSubscriptionStore({
        emptyState: EMPTY_MACHINE_PROCESSES_STATE, createState: () => EMPTY_MACHINE_PROCESSES_STATE,
        normalizeInput: input => ({ ...input, serverId: input.serverId ?? null }),
        storeKey,
        defaultSnapshotClient: clients.snapshotClient, defaultWatchClient: clients.watchClient, retainState: true, watchAfterRefresh: true,
        beginRefresh: (state, input): MachineProcessesState => state.answer || !input.detailToken ? state : store.getState({ ...input, detailToken: undefined }),
        shouldWatch: state => state.status === 'ready',
        refresh: async ({ input, state, snapshotClient, signal }) => {
            const result = await snapshotClient({ ...input, signal });
            if (signal?.aborted) return state;
            const current = store.getState(input);
            return result.ok ? adopt(current, result.value) : apply(current, { kind: 'failure', reason: result.reason });
        },
        failRefresh: state => settle(state, { ...state, status: 'error' }), applySnapshot: apply,
        watch: async ({ input, state, watchClient, signal }) => {
            const held = state.answer?.history;
            const historySince = newestHistorySample(held);
            const result = await watchClient({ ...input, ...(state.answer ? { since: state.answer.capturedAtMs } : {}),
                ...(historySince === undefined ? {} : { historySince }), signal });
            if (signal?.aborted) return { status: 'unavailable' };
            if (!result.ok) {
                store.publish(input, { kind: 'failure', reason: result.reason });
                return { status: 'unavailable' };
            }
            if (!result.value.changed) return { status: 'idle' };
            const answer = result.value.answer;
            const history = historySince === undefined ? answer.history : mergeHistory(held, answer.history);
            return { status: 'changed', snapshot: { kind: 'answer', answer: history === answer.history ? answer : { ...answer, ...(history ? { history } : {}) } } };
        },
    });
    return { getState(input: MachineProcessesKey) {
        const state = store.getState(input);
        return state.answer || !input.detailToken ? state : store.getState({ ...input, detailToken: undefined });
    }, observe: store.observe, demand: (input: MachineProcessesKey, listener: () => void = () => {}) => store.subscribe(input, listener),
        read: store.read, retry: store.invalidate,
        /** Fresh daemon publication recovers a failed read; healthy parked watches already own freshness. */
        daemonStateChanged(input: MachineProcessesKey, version: number | null | undefined) {
            if (version == null) return;
            const key = storeKey(input);
            if (daemonVersions.get(key) === version) return;
            daemonVersions.set(key, version);
            const state = store.getState(input);
            if (state.status === 'error' || state.status === 'unavailable' || state.status === 'not_supported') store.invalidate(input);
        },
        reset() { store.reset(); daemonVersions.clear(); } };
}
export const machineProcessesStore = createMachineProcessesStore({
    snapshotClient: async input => (await import('./machineProcessesRpc')).fetchMachineProcessesViaMachineRpc(input),
    watchClient: async input => (await import('./machineProcessesRpc')).watchMachineProcessesViaMachineRpc(input),
});
