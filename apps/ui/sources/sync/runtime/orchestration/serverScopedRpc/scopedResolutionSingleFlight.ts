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
    /** Register physical custody or a selected batch item before dispatch/borrower retirement. */
    onPhysicalAcquire?: (signal: AbortSignal) => (() => void | Promise<void>) | void;
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
                let dispose: (() => void | Promise<void>) | void;
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

type BatchRead<T> = (ids: readonly string[], signal: AbortSignal) => Promise<ReadonlyMap<string, T>>;

export type ScopedBatchReadPreparation<T> = Readonly<{
    /** Settle this reservation once the caller has prepared its selected ids. */
    run: (ids: readonly string[], read: BatchRead<T>, signal?: AbortSignal) => Promise<ReadonlyMap<string, T>>;
    /** A failed or abandoned preparation must not hold other ready readers. */
    release: () => void;
}>;

export type ScopedBatchResolutionSingleFlight<T> = Readonly<{
    /** Register before awaiting preparation, under the already captured authority/projection key. */
    reserve: (groupKey: string, options?: ScopedReadOptions) => ScopedBatchReadPreparation<T>;
    run: (groupKey: string, ids: readonly string[],
        read: BatchRead<T>,
        options?: ScopedReadOptions) => Promise<ReadonlyMap<string, T>>;
    invalidate: (scope?: ReadPartitionScope) => void;
    reset: () => void;
}>;

/** Gathers ids at the same pending owner; each typed adapter keeps its existing wire/body budget. */
export function createScopedBatchResolutionSingleFlight<T>(): ScopedBatchResolutionSingleFlight<T> {
    const defaultScope = {};
    type Item = { id: string; signal: AbortSignal; read: BatchRead<T>; accept: (value: T) => void; reject: (error: unknown) => void };
    type Batch = { items: Item[]; preparations: number; scheduled: boolean };
    type Partition = { reads: ScopedResolutionSingleFlight<T>; groups: Map<string, Batch>; users: number };
    const partitions = createReadPartitions<Partition>();

    function acquire(options: ScopedReadOptions) {
        throwIfAborted(options.signal);
        const scope = options.fresh ? {} : options.scope ?? defaultScope;
        let partition = partitions.get(scope);
        if (!partition) {
            partition = { reads: createScopedResolutionSingleFlight<T>(), groups: new Map(), users: 0 };
            partitions.set(scope, partition);
        }
        const captured = partition;
        captured.users += 1;
        return { partition: captured, release: () => {
            captured.users -= 1;
            if (captured.users === 0 && captured.groups.size === 0) partitions.forget(scope, captured);
        }, forgetIfIdle: () => {
            if (captured.users === 0 && captured.groups.size === 0) partitions.forget(scope, captured);
        } };
    }

    function batchFor(partition: Partition, groupKey: string): Batch {
        let batch = partition.groups.get(groupKey);
        if (!batch) {
            batch = { items: [], preparations: 0, scheduled: false };
            partition.groups.set(groupKey, batch);
        }
        return batch;
    }

    function flushWhenPrepared(acquisition: ReturnType<typeof acquire>, groupKey: string, batch: Batch) {
        if (batch.scheduled || batch.preparations > 0) return;
        batch.scheduled = true;
        // Only registered preparations define the frontier; Promise depth and
        // timer service never determine how long an ordinary batch gathers.
        queueMicrotask(() => {
            batch.scheduled = false;
            if (batch.preparations > 0) return;
            if (acquisition.partition.groups.get(groupKey) === batch) acquisition.partition.groups.delete(groupKey);
            acquisition.forgetIfIdle();
            void dispatch(batch);
        });
    }

    async function dispatch(batch: Batch) {
        const items = batch.items.filter(item => !item.signal.aborted);
        for (const item of batch.items) if (item.signal.aborted) item.reject(abortReason(item.signal));
        const first = items[0];
        if (!first) return;
        const abort = new AbortController();
        const cancelIfUnwanted = () => {
            if (items.every(item => item.signal.aborted)) abort.abort();
        };
        for (const item of items) item.signal.addEventListener('abort', cancelIfUnwanted, { once: true });
        try {
            cancelIfUnwanted();
            throwIfAborted(abort.signal);
            const result = await first.read(items.map(item => item.id), abort.signal);
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

    async function run(acquisition: ReturnType<typeof acquire>, groupKey: string, batch: Batch,
        ids: readonly string[], read: BatchRead<T>, options: ScopedReadOptions, signal?: AbortSignal) {
        const invocation = new AbortController();
        const cancellation = mergeAbortSignals([invocation.signal, options.signal, signal]);
        try {
            throwIfAborted(cancellation.signal);
            const pending = Promise.all([...new Set(ids)].map(async id => {
                let selected!: Promise<T>;
                const value = await acquisition.partition.reads.run(JSON.stringify([groupKey, id]), () => selected, {
                    signal: cancellation.signal,
                    onPhysicalAcquire: signal => {
                        // Selection is synchronous: a ready flush may already
                        // be queued when another preparation settles its ids.
                        selected = new Promise<T>((accept, reject) => {
                            batch.items.push({ id, signal, read, accept, reject });
                        });
                        // The last borrower can leave before the deferred
                        // resolver runs; dispatch still settles its queued item.
                        void selected.catch(() => {});
                        flushWhenPrepared(acquisition, groupKey, batch);
                    },
                });
                return [id, value] as const;
            }));
            flushWhenPrepared(acquisition, groupKey, batch);
            const values = await pending;
            throwIfAborted(cancellation.signal);
            return new Map(values);
        } finally {
            // Promise.all can fail while sibling items remain pending. This
            // invocation no longer wants them; independent borrowers stay.
            invocation.abort();
            cancellation.dispose();
            acquisition.release();
        }
    }

    return {
        reserve(groupKey, options = {}) {
            const acquisition = acquire(options);
            const batch = batchFor(acquisition.partition, groupKey);
            batch.preparations += 1;
            let open = true;
            const release = () => {
                if (!open) return;
                open = false;
                options.signal?.removeEventListener('abort', release);
                batch.preparations -= 1;
                flushWhenPrepared(acquisition, groupKey, batch);
                acquisition.release();
            };
            options.signal?.addEventListener('abort', release, { once: true });
            return {
                run(ids, read, signal) {
                    if (!open) {
                        return Promise.reject(options.signal?.aborted ? abortReason(options.signal)
                            : new Error('Scoped read preparation has already ended'));
                    }
                    // Retain this exact partition even if invalidation has
                    // withdrawn its joins while preparation was awaiting.
                    acquisition.partition.users += 1;
                    try { return run(acquisition, groupKey, batch, ids, read, options, signal); }
                    finally { release(); }
                },
                release,
            };
        },
        async run(groupKey, ids, read, options = {}) {
            const acquisition = acquire(options);
            return await run(acquisition, groupKey, batchFor(acquisition.partition, groupKey), ids, read, options);
        },
        invalidate(scope = defaultScope) {
            // Incumbents keep their own pending owner; preparations may not
            // join or delay the successor partition after invalidation.
            partitions.invalidate(scope);
        },
        reset() {
            partitions.clear();
        },
    };
}
