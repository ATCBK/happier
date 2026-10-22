import { mergeAbortSignals, throwIfAborted } from '@/utils/runtime/abortSignals';

/** The typed reader supplies complete authority, projection and invalidation identity. */
export type ScopedReadOptions = Readonly<{
    signal?: AbortSignal;
    /** Opaque captured authorities stay identity-partitioned; proven neutral bindings use their key. */
    scope?: ReadPartitionScope;
    /** A required fresh witness cannot join an earlier ordinary acquisition. */
    fresh?: boolean;
}>;

type ReadScope = object | string;
type ReadPartitionScope = ReadScope | readonly ReadScope[];

export type ScopedPhysicalReadOptions = ScopedReadOptions & Readonly<{
    /** Transfer prepared RPC custody synchronously, before dispatch or borrower retirement. */
    onPhysicalAcquire?: (signal: AbortSignal) => (() => void | Promise<void>);
}>;

/** Ordered existing references partition pending work without assigning identities to them. */
function createReadPartitions<T>() {
    type Node = { children: Map<ReadScope, Node>; value?: T };
    const root: Node = { children: new Map() };
    const path = (scope: ReadPartitionScope): readonly ReadScope[] => Array.isArray(scope) ? scope : [scope];
    const find = (scope: ReadPartitionScope, create: boolean) => {
        let node = root;
        for (const key of path(scope)) {
            let child = node.children.get(key);
            if (!child) {
                if (!create) return undefined;
                child = { children: new Map() };
                node.children.set(key, child);
            }
            node = child;
        }
        return node;
    };
    const remove = (scope: ReadPartitionScope, expected?: T) => {
        let node = root;
        const ancestry: Array<{ parent: Node; key: ReadScope; child: Node }> = [];
        for (const key of path(scope)) {
            const child = node.children.get(key);
            if (!child) return;
            ancestry.push({ parent: node, key, child });
            node = child;
        }
        if (expected !== undefined && node.value !== expected) return;
        delete node.value;
        if (expected === undefined) node.children.clear();
        for (let index = ancestry.length - 1; index >= 0; index -= 1) {
            const { parent, key, child } = ancestry[index]!;
            if (child.value !== undefined || child.children.size > 0 || parent.children.get(key) !== child) break;
            parent.children.delete(key);
        }
    };
    return {
        get: (scope: ReadPartitionScope) => find(scope, false)?.value,
        set: (scope: ReadPartitionScope, value: T) => { find(scope, true)!.value = value; },
        forget: (scope: ReadPartitionScope, value: T) => remove(scope, value),
        invalidate: (scope: ReadPartitionScope) => remove(scope),
        clear: () => { root.children.clear(); delete root.value; },
    };
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? Object.assign(new Error('Scoped read cancelled'), { name: 'AbortError' });
}

/** Pending work only: parsing, admission, retry cadence and retained data belong to domain owners. */
export type ScopedResolutionSingleFlight<T> = Readonly<{
    run: (key: string, resolve: (signal: AbortSignal) => Promise<T>, options?: ScopedPhysicalReadOptions) => Promise<T>;
    /** Forget joins after a write/wake without cancelling incumbent operations or their publication fences. */
    invalidate: (scope?: ReadPartitionScope) => void;
    reset: () => void;
}>;

export function createScopedResolutionSingleFlight<T>(): ScopedResolutionSingleFlight<T> {
    type Flight = { result: Promise<T>; abort: AbortController; waiters: number; settled: boolean };
    const defaultScope = {};
    const partitions = createReadPartitions<Map<string, Flight>>();

    return {
        async run(key, resolve, options = {}) {
            throwIfAborted(options.signal);
            const scope = options.fresh ? {} : options.scope ?? defaultScope;
            let reads = partitions.get(scope);
            if (!reads) {
                reads = new Map();
                partitions.set(scope, reads);
            }
            const partition = reads;
            let flight = partition.get(key);
            const forget = (entry: Flight) => {
                if (partition.get(key) !== entry) return;
                partition.delete(key);
                if (partition.size === 0) partitions.forget(scope, partition);
            };
            if (!flight) {
                const abort = new AbortController();
                let dispose: (() => void | Promise<void>) | undefined;
                try {
                    dispose = options.onPhysicalAcquire?.(abort.signal);
                } catch (error) {
                    if (partition.size === 0) partitions.forget(scope, partition);
                    throw error;
                }
                const operation = Promise.resolve().then(() => {
                    throwIfAborted(abort.signal);
                    return resolve(abort.signal);
                });
                // Also disposes a selected capture when its final borrower
                // leaves before the deferred resolver gets a chance to run.
                const result = dispose ? operation.finally(dispose) : operation;
                flight = { result, abort, waiters: 0, settled: false };
                const created = flight;
                partition.set(key, created);
                const finish = () => { created.settled = true; forget(created); };
                void result.then(finish, finish);
            }
            const read = flight;
            read.waiters += 1;
            return await new Promise<T>((accept, reject) => {
                let left = false;
                const leave = () => {
                    if (left) return;
                    left = true;
                    options.signal?.removeEventListener('abort', onAbort);
                    read.waiters -= 1;
                    if (read.waiters === 0 && !read.settled) {
                        forget(read);
                        read.abort.abort(options.signal?.reason);
                    }
                };
                const onAbort = () => {
                    if (left || !options.signal) return;
                    const reason = abortReason(options.signal);
                    leave();
                    reject(reason);
                };
                options.signal?.addEventListener('abort', onAbort, { once: true });
                if (options.signal?.aborted) onAbort();
                void read.result.then(value => {
                    if (left) return;
                    leave();
                    accept(value);
                }, error => {
                    if (left) return;
                    leave();
                    reject(error);
                });
            });
        },
        invalidate(scope = defaultScope) {
            partitions.invalidate(scope);
        },
        reset() {
            partitions.clear();
        },
    };
}

export type ScopedBatchResolutionSingleFlight<T> = Readonly<{
    run: (groupKey: string, ids: readonly string[],
        read: (ids: readonly string[], signal: AbortSignal) => Promise<ReadonlyMap<string, T>>,
        options?: ScopedReadOptions) => Promise<ReadonlyMap<string, T>>;
    invalidate: (scope?: ReadPartitionScope) => void;
    reset: () => void;
}>;

/** Gathers ids at the same pending owner; each typed adapter keeps its existing wire/body budget. */
export function createScopedBatchResolutionSingleFlight<T>(): ScopedBatchResolutionSingleFlight<T> {
    const reads = createScopedResolutionSingleFlight<T>();
    const defaultScope = {};
    type Item = { id: string; signal: AbortSignal; accept: (value: T) => void; reject: (error: unknown) => void };
    type Batch = { items: Item[]; read: Parameters<ScopedBatchResolutionSingleFlight<T>['run']>[2] };
    const queues = createReadPartitions<Map<string, Batch>>();

    async function dispatch(batch: Batch) {
        const items = batch.items.filter(item => !item.signal.aborted);
        for (const item of batch.items) if (item.signal.aborted) item.reject(abortReason(item.signal));
        if (items.length === 0) return;
        const abort = new AbortController();
        const cancelIfUnwanted = () => {
            if (items.every(item => item.signal.aborted)) abort.abort();
        };
        for (const item of items) item.signal.addEventListener('abort', cancelIfUnwanted, { once: true });
        try {
            cancelIfUnwanted();
            throwIfAborted(abort.signal);
            const result = await batch.read(items.map(item => item.id), abort.signal);
            for (const item of items) {
                if (item.signal.aborted) item.reject(abortReason(item.signal));
                else if (!result.has(item.id)) item.reject(new Error('Scoped batch omitted a requested resource'));
                // Map.has establishes presence even when T itself permits undefined.
                else item.accept(result.get(item.id) as T);
            }
        } catch (error) {
            for (const item of items) item.reject(error);
        } finally {
            for (const item of items) item.signal.removeEventListener('abort', cancelIfUnwanted);
        }
    }

    return {
        async run(groupKey, ids, read, options = {}) {
            throwIfAborted(options.signal);
            const scope = options.fresh ? {} : options.scope ?? defaultScope;
            const invocation = new AbortController();
            const cancellation = mergeAbortSignals([invocation.signal, options.signal]);
            try {
                const values = await Promise.all([...new Set(ids)].map(async id => {
                    const value = await reads.run(JSON.stringify([groupKey, id]), signal => new Promise<T>((accept, reject) => {
                        let groups = queues.get(scope);
                        if (!groups) { groups = new Map(); queues.set(scope, groups); }
                        const partition = groups;
                        let batch = partition.get(groupKey);
                        if (!batch) {
                            batch = { items: [], read };
                            const created = batch;
                            partition.set(groupKey, created);
                            // Gather through a short preparation chain without depending on
                            // timer tasks (which consumer clocks may freeze). This is
                            // best-effort coalescing, not global microtask quiescence;
                            // later asks still share any identical pending resource read.
                            let preparationTurns = 32;
                            const flush = () => {
                                if (preparationTurns-- > 0) { queueMicrotask(flush); return; }
                                if (partition.get(groupKey) === created) partition.delete(groupKey);
                                if (partition.size === 0) queues.forget(scope, partition);
                                void dispatch(created);
                            };
                            queueMicrotask(flush);
                        }
                        batch.items.push({ id, signal, accept, reject });
                    }), { scope, signal: cancellation.signal });
                    return [id, value] as const;
                }));
                throwIfAborted(options.signal);
                return new Map(values);
            } finally {
                // Promise.all can fail while sibling items remain pending. This
                // invocation no longer wants them; independent borrowers stay.
                invocation.abort();
                cancellation.dispose();
            }
        },
        invalidate(scope = defaultScope) {
            reads.invalidate(scope);
            queues.invalidate(scope);
        },
        reset() {
            reads.reset();
            queues.clear();
        },
    };
}
