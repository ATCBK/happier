import type { MachineProcessesAnswerV1, MachineProcessesWatchResultV1, OwnerRowV1, ProcessRowV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
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
function reconcile(previous: MachineProcessesAnswerV1 | null, answer: MachineProcessesAnswerV1): MachineProcessesAnswerV1 {
    if (!previous) return answer;
    const byId = new Map(previous.owners.map(owner => [owner.rowId, owner]));
    const owners = answer.owners.map(owner => {
        const old = byId.get(owner.rowId);
        return old ? retain(old, { ...owner, members: retainRows(old.members, owner.members), totals: retain(old.totals, owner.totals) } satisfies OwnerRowV1) : owner;
    });
    return retain(previous, { ...answer, owners: retain(previous.owners, owners), leftBehind: retainRows(previous.leftBehind, answer.leftBehind),
        totals: retain(previous.totals, answer.totals),
        ...(answer.notHappier ? { notHappier: retain(previous.notHappier, answer.notHappier) } : {}),
        ...(answer.history ? { history: retain(previous.history, answer.history) } : {}) });
}
function adopt(state: MachineProcessesState, answer: MachineProcessesAnswerV1): MachineProcessesState {
    if (state.answer && state.answer.capturedAtMs > answer.capturedAtMs) return state;
    if (answer.state === 'unavailable') return retain(state, { status: 'unavailable', reason: answer.reason,
        answer: state.answer?.state === 'live' ? state.answer : answer });
    return retain(state, { status: answer.state === 'live' ? 'ready' : 'unavailable', answer: reconcile(state.answer, answer) });
}
function apply(state: MachineProcessesState, update: ProcessUpdate): MachineProcessesState {
    return update.kind === 'answer' ? adopt(state, update.answer)
        : retain(state, { ...state, reason: update.reason, status: update.reason === 'older_happier' ? 'not_supported' : 'error' });
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
        failRefresh: state => retain(state, { ...state, status: 'error' }), applySnapshot: apply,
        watch: async ({ input, state, watchClient, signal }) => {
            const result = await watchClient({ ...input, ...(state.answer ? { since: state.answer.capturedAtMs } : {}), signal });
            if (signal?.aborted) return { status: 'unavailable' };
            if (!result.ok) {
                store.publish(input, { kind: 'failure', reason: result.reason });
                return { status: 'unavailable' };
            }
            return result.value.changed ? { status: 'changed', snapshot: { kind: 'answer', answer: result.value.answer } } : { status: 'idle' };
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
