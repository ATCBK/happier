export type SharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient = never> = Readonly<{
    snapshotClient?: TSnapshotClient;
    watchClient?: TWatchClient;
    nowMs?: () => number;
}>;

export type SharedSubscriptionRefreshParams<TInput, TState, TSnapshotClient> = Readonly<{
    input: TInput;
    state: TState;
    snapshotClient: TSnapshotClient;
    nowMs: () => number;
    signal?: AbortSignal;
}>;

/**
 * One parked watch answer.
 *
 * `changed` carries the daemon's new snapshot; `idle` means the daemon's park window elapsed with
 * nothing to report and the store re-arms; `unavailable` retires the watch for this entry until a
 * user-initiated refresh, fresh snapshot publication or foreground invalidation restarts it. There is deliberately no retry,
 * backoff or breaker here: the daemon owns the wait, so re-arming is rate-limited by its window,
 * and an unavailable watch degrades to the explicit refresh path rather than to a client timer.
 */
export type SharedSubscriptionWatchOutcome<TSnapshot> =
    | Readonly<{ status: 'changed'; snapshot: TSnapshot }>
    | Readonly<{ status: 'idle' }>
    | Readonly<{ status: 'unavailable' }>;

export type SharedSubscriptionWatchParams<TInput, TState, TWatchClient> = Readonly<{
    input: TInput;
    state: TState;
    watchClient: TWatchClient;
    nowMs: () => number;
    signal?: AbortSignal;
}>;

export type SharedSubscriptionStoreConfig<
    TInput,
    TState,
    TSnapshot,
    TSnapshotClient,
    TWatchClient = never,
> = Readonly<{
    emptyState: TState;
    createState: () => TState;
    normalizeInput: (input: TInput) => TInput;
    storeKey: (input: TInput) => string;
    defaultSnapshotClient: TSnapshotClient;
    /** Keep last-known state for the app session after the last demand leaves. */
    retainState?: boolean;
    shouldRefresh?: (state: TState) => boolean;
    shouldWatch?: (state: TState) => boolean;
    /** Seed the watch cursor from the immediate read before parking. */
    watchAfterRefresh?: boolean;
    beginRefresh?: (state: TState, input: TInput, nowMs: () => number) => TState;
    refresh: (params: SharedSubscriptionRefreshParams<TInput, TState, TSnapshotClient>) => Promise<TState>;
    failRefresh?: (state: TState, input: TInput, nowMs: () => number, error: unknown) => TState;
    applySnapshot: (state: TState, snapshot: TSnapshot) => TState;
    matchesPublish?: (entryInput: TInput, publishInput: TInput) => boolean;
    /**
     * Whether a published snapshot actually covers a matching entry's scope.
     *
     * `matchesPublish` answers "could this publication affect this entry"; this answers "does the
     * payload it carried describe this entry". They differ for a domain whose entries are narrower
     * than a publication — a public-preview entry pinned to one `exposureId` is affected by a
     * session-wide publication but must not adopt a snapshot describing a different exposure. When
     * this returns false the entry refreshes instead of applying, so it converges on its own scope
     * rather than silently showing another scope's state. Omit it and every matching entry applies
     * the snapshot, which is right for a domain whose entries and publications share a scope.
     */
    snapshotCoversEntry?: (entryInput: TInput, snapshot: TSnapshot, publishInput: TInput) => boolean;
    /**
     * Optional push half. While an entry has subscribers the store keeps exactly one watch
     * outstanding and re-arms it on every answer, so a domain that supplies this stays fresh
     * without any interval. Domains that do not supply it keep the pull-only lifecycle.
     */
    defaultWatchClient?: TWatchClient;
    watch?: (
        params: SharedSubscriptionWatchParams<TInput, TState, TWatchClient>,
    ) => Promise<SharedSubscriptionWatchOutcome<TSnapshot>>;
}>;

export type SharedSubscriptionStore<
    TInput,
    TState,
    TSnapshot,
    TSnapshotClient,
    TWatchClient = never,
> = Readonly<{
    getState(input: TInput): TState;
    observe(input: TInput, listener: () => void): () => void;
    read(input: TInput, options?: SharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient>): Promise<void>;
    readOnce(input: TInput, options?: SharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient>): Promise<void>;
    subscribe(
        input: TInput,
        listener: () => void,
        options?: SharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient>,
    ): () => void;
    invalidate(input: TInput): void;
    publish(input: TInput, snapshot: TSnapshot): void;
    reset(): void;
}>;

type SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient, TWatchClient> = {
    readonly input: TInput;
    state: TState;
    snapshotClient: TSnapshotClient;
    watchClient: TWatchClient;
    readonly listeners: Set<() => void>;
    refCount: number;
    inFlight: Promise<void> | null;
    refreshRequested: boolean;
    readStarted: boolean;
    abortController: AbortController | null;
    watchAbortController: AbortController | null;
    watching: boolean;
    watchRetired: boolean;
    watchRecoveryRequested: boolean;
    nowMs: () => number;
};

function notify<TInput, TState, TSnapshotClient, TWatchClient>(
    entry: SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient, TWatchClient>,
): void {
    for (const listener of entry.listeners) {
        listener();
    }
}

export function createSharedSubscriptionStore<
    TInput,
    TState,
    TSnapshot,
    TSnapshotClient,
    TWatchClient = never,
>(
    config: SharedSubscriptionStoreConfig<TInput, TState, TSnapshot, TSnapshotClient, TWatchClient>,
): SharedSubscriptionStore<TInput, TState, TSnapshot, TSnapshotClient, TWatchClient> {
    type Entry = SharedSubscriptionStoreEntry<TInput, TState, TSnapshotClient, TWatchClient>;
    const entries = new Map<string, Entry>();

    const setState = (
        entry: Entry,
        next: TState,
    ): void => {
        if (entry.state === next) {
            return;
        }
        entry.state = next;
        notify(entry);
    };

    const ensureEntry = (
        key: string,
        input: TInput,
        options?: SharedSubscriptionStoreOptions<TSnapshotClient, TWatchClient>,
    ): Entry => {
        let entry = entries.get(key);
        if (!entry) {
            entry = {
                input,
                state: config.createState(),
                snapshotClient: options?.snapshotClient ?? config.defaultSnapshotClient,
                watchClient: (options?.watchClient ?? config.defaultWatchClient) as TWatchClient,
                listeners: new Set(),
                refCount: 0,
                inFlight: null,
                refreshRequested: false,
                readStarted: false,
                abortController: null,
                watchAbortController: null,
                watching: false,
                watchRetired: false,
                watchRecoveryRequested: false,
                nowMs: options?.nowMs ?? Date.now,
            };
            entries.set(key, entry);
        } else {
            if (options?.snapshotClient) {
                entry.snapshotClient = options.snapshotClient;
            }
            if (options?.watchClient) {
                entry.watchClient = options.watchClient;
            }
            if (options?.nowMs) {
                entry.nowMs = options.nowMs;
            }
        }
        return entry;
    };

    const runRefresh = (
        entry: Entry,
    ): Promise<void> => {
        if (entry.inFlight) return entry.inFlight;
        if (config.shouldRefresh?.(entry.state) === false) return Promise.resolve();
        entry.refreshRequested = false;
        entry.readStarted = true;
        const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        entry.abortController = abortController;
        if (config.beginRefresh) {
            setState(entry, config.beginRefresh(entry.state, entry.input, entry.nowMs));
        }
        const promise = (async () => { try {
            const next = await config.refresh({
                input: entry.input,
                state: entry.state,
                snapshotClient: entry.snapshotClient,
                nowMs: entry.nowMs,
                signal: abortController?.signal,
            });
            if (!abortController?.signal.aborted) {
                setState(entry, next);
            }
        } catch (error) {
            if (!abortController?.signal.aborted && config.failRefresh) {
                setState(entry, config.failRefresh(entry.state, entry.input, entry.nowMs, error));
            }
        } finally {
            entry.inFlight = null;
            if (entry.abortController === abortController) {
                entry.abortController = null;
            }
            // A mutation or source update during this read must not be swallowed by
            // single-flight sharing. Coalesce those invalidations into one subsequent read.
            if (entry.refreshRequested && entry.refCount > 0 && !abortController?.signal.aborted) {
                void runRefresh(entry);
            }
        } })();
        entry.inFlight = promise;
        return promise;
    };

    // The push half. Exactly one watch is outstanding per entry with subscribers; every answer
    // re-arms the next one, so the cadence is the daemon's park window and there is no timer here.
    // An unavailable watch retires until invalidation or snapshot publication restores it.
    // Both user Refresh and the foreground trigger reuse these owners.
    const runWatchLoop = (entry: Entry): void => {
        const watch = config.watch;
        if (!watch || entry.watching || entry.watchRetired || entry.refCount <= 0 || config.shouldWatch?.(entry.state) === false) {
            return;
        }
        entry.watching = true;
        entry.watchRecoveryRequested = false;
        const abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
        entry.watchAbortController = abortController;
        void (async () => {
            try {
                const outcome = await watch({
                    input: entry.input,
                    state: entry.state,
                    watchClient: entry.watchClient,
                    nowMs: entry.nowMs,
                    ...(abortController ? { signal: abortController.signal } : {}),
                });
                if (abortController?.signal.aborted || entry.refCount <= 0) {
                    return;
                }
                if (outcome.status === 'unavailable') {
                    entry.watchRetired = !entry.watchRecoveryRequested;
                }
                if (outcome.status === 'changed') {
                    setState(entry, config.applySnapshot(entry.state, outcome.snapshot));
                }
            } catch {
                if (!abortController?.signal.aborted) entry.watchRetired = !entry.watchRecoveryRequested;
            } finally {
                if (entry.watchAbortController === abortController) {
                    entry.watching = false;
                    entry.watchAbortController = null;
                }
            }
            if (!abortController?.signal.aborted) runWatchLoop(entry);
        })();
    };

    const stopWatch = (entry: Entry): void => {
        entry.watchAbortController?.abort();
        entry.watchAbortController = null;
        entry.watching = false;
    };

    return {
        getState(input) {
            const normalized = config.normalizeInput(input);
            return entries.get(config.storeKey(normalized))?.state ?? config.emptyState;
        },
        observe(input, listener) {
            const normalized = config.normalizeInput(input);
            const entry = ensureEntry(config.storeKey(normalized), normalized);
            entry.listeners.add(listener);
            return () => { entry.listeners.delete(listener); };
        },
        read(input, options) {
            const normalized = config.normalizeInput(input);
            return runRefresh(ensureEntry(config.storeKey(normalized), normalized, options));
        },
        readOnce(input, options) {
            const normalized = config.normalizeInput(input);
            const entry = ensureEntry(config.storeKey(normalized), normalized, options);
            return entry.inFlight ?? (entry.readStarted ? Promise.resolve() : runRefresh(entry));
        },
        subscribe(input, listener, options) {
            const normalized = config.normalizeInput(input);
            const key = config.storeKey(normalized);
            const entry = ensureEntry(key, normalized, options);
            let subscribed = true;
            entry.listeners.add(listener);
            entry.refCount += 1;
            if (entry.refCount === 1) {
                const previousWasAborted = entry.abortController?.signal.aborted;
                const refresh = runRefresh(entry);
                if (config.watchAfterRefresh) {
                    void refresh.then(async () => {
                        if (entry.refCount <= 0) return;
                        if (previousWasAborted) await runRefresh(entry);
                        runWatchLoop(entry);
                    });
                }
            }
            if (!config.watchAfterRefresh) runWatchLoop(entry);
            return () => {
                if (!subscribed) {
                    return;
                }
                subscribed = false;
                entry.listeners.delete(listener);
                entry.refCount -= 1;
                if (entry.refCount <= 0) {
                    entry.abortController?.abort();
                    stopWatch(entry);
                    if (!config.retainState) entries.delete(key);
                }
            };
        },
        invalidate(input) {
            const normalized = config.normalizeInput(input);
            const entry = entries.get(config.storeKey(normalized));
            // An explicit invalidation also permits a new one-shot read of a retained entry.
            if (entry) entry.readStarted = false;
            if (entry && entry.refCount > 0) {
                if (entry.inFlight) entry.refreshRequested = true;
                const refresh = runRefresh(entry);
                // A user-initiated refresh is also the recovery path for a retired watch.
                if (entry.watching) entry.watchRecoveryRequested = true;
                entry.watchRetired = false;
                if (config.watchAfterRefresh) void refresh.then(() => runWatchLoop(entry));
                else runWatchLoop(entry);
            }
        },
        publish(input, snapshot) {
            const normalized = config.normalizeInput(input);
            const matchesPublish = config.matchesPublish;
            const snapshotCoversEntry = config.snapshotCoversEntry;
            for (const entry of entries.values()) {
                const matches = matchesPublish
                    ? matchesPublish(entry.input, input)
                    : config.storeKey(entry.input) === config.storeKey(normalized);
                if (!matches) {
                    continue;
                }
                if (snapshotCoversEntry && !snapshotCoversEntry(entry.input, snapshot, input)) {
                    if (entry.inFlight) entry.refreshRequested = true;
                    void runRefresh(entry);
                    continue;
                }
                setState(entry, config.applySnapshot(entry.state, snapshot));
                // An Action's successful read publishes here instead of calling
                // invalidate. Its fresh snapshot also restores the parked watch;
                // otherwise a recovered surface stops receiving later changes.
                if (entry.watching) entry.watchRecoveryRequested = true;
                entry.watchRetired = false;
                runWatchLoop(entry);
            }
        },
        reset() {
            for (const entry of entries.values()) {
                entry.abortController?.abort();
                stopWatch(entry);
            }
            entries.clear();
        },
    };
}
