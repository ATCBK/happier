import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    subscribeHomeAccountChange,
    subscribeHomeCredentialChange,
    type HomeAccountChangeEvent,
    type HomeCredentialMutationEvent,
} from '@/sync/runtime/orchestration/homeAccountChange';

/**
 * The loading lifecycle shared by every server-Account-scoped, reconstructible
 * snapshot domain.
 *
 * Home governance and Teams are woken by the same content-free Account-change
 * signal, so *when to refetch* is one decision and lives here. A domain supplies
 * only what it owns: how to read its target and how to mark its own rows stale.
 *
 * The lifecycle is deliberately small — observation counting, single flight, one
 * coalesced trailing reload, captured-Account cleanup, and one refcounted lifecycle subscription pair. There is no cursor,
 * replay, generation, ordering machinery, second socket or polling timer.
 */

export type ScopedLoadTarget = Readonly<{
    /** Collision-safe identity of the exact thing being loaded. */
    key: string;
    /** The Home this target belongs to, used to match the wake. */
    serverId: string;
}>;

export type ScopedSnapshotLoader<TTarget extends ScopedLoadTarget> = Readonly<{
    /** Registers a live consumer and loads when the domain says it is needed. */
    observe: (target: TTarget) => () => void;
    /** Explicit retry. Coalesces with an in-flight load for the same target. */
    refresh: (target: TTarget) => Promise<void>;
    /** Invalidates now and awaits the newest load, including a required trailing reload. */
    invalidate: (target: TTarget) => Promise<void>;
    /** A cursor read shares its observed sequence's cancellation lifetime. */
    readContinuation: (target: TTarget, read: (signal: AbortSignal) => Promise<void>) => Promise<void>;
    resetForTests: () => void;
}>; 

export type ScopedSnapshotLoadContext = Readonly<{
    /** Canceled when demand leaves or this sequence is replaced. Finite reads own their call lifetime. */
    signal: AbortSignal;
    /**
     * Whether this request can publish authority-bearing data as current.
     * A wake or observer gap that happened after the request began makes
     * its answer useful for continuity only; the queued read is authoritative.
     */
    isCurrent: () => boolean;
    /** Publishes a checked read before its retained cleanup, without late obsolete publication. */
    readWithMaintenance: <TProjection>(input: Readonly<{
        read: (publication: ScopedSnapshotReadPublication<TProjection>) => Promise<TProjection>;
        /** Freshness can lapse during a read while its captured Account still admits display data. */
        publish: (projection: TProjection, current: boolean, isAccountCurrent?: () => boolean) => void;
        getPublication: () => unknown;
    }>) => Promise<void | ScopedSnapshotLoadMaintenance>;
}>;

export type ScopedSnapshotReadPublication<TProjection> = Readonly<{
    onReady: (projection: TProjection, isAccountCurrent: () => boolean) => void;
    hasPendingCleanup: () => boolean;
}>;

export type ScopedSnapshotLoadMaintenance = Readonly<{
    /** The reader retains and disposes its captured Account until cleanup settles. */
    maintenance: Promise<void>;
    isMaintenanceCurrent: () => boolean;
}>;

export type ScopedSnapshotLoad<TTarget> = Readonly<{ target: TTarget; context: ScopedSnapshotLoadContext }>;

type ScopedSnapshotReader<TTarget> = Readonly<{
    /** Reads the target and publishes the outcome into the domain's store. */
    load: (target: TTarget, context: ScopedSnapshotLoadContext) => Promise<void | ScopedSnapshotLoadMaintenance>;
    loadMany?: never;
    loadGroupKey?: never;
}> | Readonly<{
    load?: never;
    /** Reads the synchronously demanded set before any asynchronous admission. */
    loadMany: (loads: readonly ScopedSnapshotLoad<TTarget>[], signal: AbortSignal) => Promise<void>;
    /** Exact independent read boundary, e.g. captured Account and application. */
    loadGroupKey: (target: TTarget) => string;
}>;

export function createScopedSnapshotLoader<TTarget extends ScopedLoadTarget>(params: ScopedSnapshotReader<TTarget> & Readonly<{
    /**
     * Whether a newly observed target needs a read. The domain decides this from
     * its own store during one uninterrupted observation period. Returning
     * after the last observer left always revalidates because wakes were absent.
     */
    shouldLoadOnObserve: (target: TTarget) => boolean;
    /** Marks the domain's rows for one Home stale. Called before refetching. */
    invalidateServer: (serverId: string) => void;
    /** Marks this exact retained target stale; the domain distinguishes advisory reloads from retirement. */
    invalidateTarget: (target: TTarget, reason: 'reload' | 'explicit' | 'observer-gap') => void;
    /** Filters exact focused-Home wakes. Content-free secondary/socket wakes stay conservative. */
    matchesWake?: (event: HomeAccountChangeEvent) => boolean;
    /** A domain may narrow the demanded rows, or discard an already received revision. */
    prepareWake?: (event: HomeAccountChangeEvent, target: TTarget) => boolean;
    /** Revalidate from the socket wake even while detailed catch-up is unavailable. */
    observeCatchUpPending?: boolean;
    /**
     * Handles credential replacement/removal at this same refcounted lifecycle owner. Returning
     * true schedules a refresh; false retains the domain state established by the callback.
     */
    onCredentialMutation?: (event: HomeCredentialMutationEvent, target: TTarget) => boolean;
}>): ScopedSnapshotLoader<TTarget> {
    const observed = new Map<string, { target: TTarget; count: number }>();
    const inFlight = new Map<string, Promise<void>>();
    const lifetimes = new Map<string, AbortController>();
    const maintenance = new Map<string, { result: ScopedSnapshotLoadMaintenance; reloadAfterMaintenance: boolean }>();
    /**
     * A target read without observers, or returning after its observers left, cannot remain trusted as current:
     * the wake subscription is deliberately absent during that interval. Keep
     * the domain's last-known-good rows, but force the next first observer to
     * revalidate them even when the store still reports a fresh snapshot.
     * Finite settlement requests that later revalidation without retroactively
     * retiring the read; an actual observer gap also withdraws its currentness.
     */
    const revalidateOnNextObserve = new Map<string, 'observer-gap' | 'finite-read'>();
    /**
     * Targets woken while their own load was already in flight. That request was
     * issued before the mutation committed, so its answer cannot contain the
     * change, and joining it would consume the only signal about that change.
     * Exactly one trailing reload runs per target; further wakes during it
     * coalesce into the same follow-up.
     */
    const reloadAfterInFlight = new Set<string>();
    let unsubscribeWake: (() => void) | null = null;
    let unsubscribeCredentials: (() => void) | null = null;

    type PendingLoad = ScopedSnapshotLoad<TTarget> & {
        resolve: () => void;
        reject: (error: unknown) => void;
    };
    const pendingLoads = new Map<string, PendingLoad[]>();

    function readTarget(target: TTarget, context: ScopedSnapshotLoadContext): Promise<void | ScopedSnapshotLoadMaintenance> {
        if (params.load) return params.load(target, context);
        const loadMany = params.loadMany;
        const key = params.loadGroupKey(target);
        return new Promise<void>((resolve, reject) => {
            // One target may leave while siblings still need the shared Action.
            // Release its own slot without canceling their result recipient.
            const finish = () => { context.signal.removeEventListener('abort', finish); resolve(); };
            const fail = (error: unknown) => { context.signal.removeEventListener('abort', finish); reject(error); };
            if (context.signal.aborted) { finish(); return; }
            context.signal.addEventListener('abort', finish, { once: true });
            const pending = pendingLoads.get(key);
            if (pending) {
                pending.push({ target, context, resolve: finish, reject: fail });
                return;
            }
            const loads = [{ target, context, resolve: finish, reject: fail }];
            pendingLoads.set(key, loads);
            // Observation, refresh and a wake supply their ready targets in one
            // turn. Collect them here, before settings/approval can split ticks.
            queueMicrotask(() => {
                pendingLoads.delete(key);
                // A set remains useful while any member of it still has demand.
                const lifetime = new AbortController();
                let remaining = 0;
                const withdraw = () => {
                    remaining -= 1;
                    if (remaining === 0) lifetime.abort();
                };
                for (const load of loads) {
                    if (load.context.signal.aborted) continue;
                    remaining += 1;
                    load.context.signal.addEventListener('abort', withdraw, { once: true });
                }
                if (remaining === 0) lifetime.abort();
                void loadMany(loads, lifetime.signal).then(() => {
                    for (const load of loads) load.resolve();
                }, error => { for (const load of loads) load.reject(error); }).finally(() => {
                    for (const load of loads) load.context.signal.removeEventListener('abort', withdraw);
                });
            });
        });
    }

    function loadOnce(target: TTarget): Promise<void> {
        const existing = inFlight.get(target.key);
        if (existing) return existing;
        let pending!: Promise<void>;
        pending = (async () => {
            try {
                while (true) {
                    let failure: unknown = null;
                    // A deciding first-page read replaces its old cursor sequence.
                    lifetimes.get(target.key)?.abort();
                    const lifetime = new AbortController();
                    lifetimes.set(target.key, lifetime);
                    try {
                        // Enter the load through a microtask so `inFlight` is registered before a
                        // domain reader can either resolve or throw synchronously.
                        const isCurrent = () => !lifetime.signal.aborted && !reloadAfterInFlight.has(target.key)
                            && revalidateOnNextObserve.get(target.key) !== 'observer-gap';
                        // Only cleanup that preceded this read can suppress it. After
                        // publication the live map may contain this read's own cleanup.
                        const incumbentMaintenance = maintenance.get(target.key);
                        let joinedIncumbentMaintenance = false;
                        const hasPendingMaintenance = () => {
                            const incumbent = incumbentMaintenance;
                            if (incumbent?.result.isMaintenanceCurrent() !== true
                                || maintenance.get(target.key) !== incumbent) {
                                // This foreground read now owns its own cleanup. It also
                                // satisfies any demand queued on the retired incumbent.
                                if (incumbent) incumbent.reloadAfterMaintenance = false;
                                return false;
                            }
                            joinedIncumbentMaintenance = true;
                            return true;
                        };
                        const result = await Promise.resolve().then(async () => await readTarget(observed.get(target.key)?.target ?? target, {
                            signal: lifetime.signal,
                            isCurrent,
                            async readWithMaintenance({ read, publish, getPublication }) {
                                let finishRead!: () => void;
                                const ready = new Promise<void>(resolve => { finishRead = resolve; });
                                let capturedCurrent: (() => boolean) | null = null;
                                let published: unknown;
                                const completion = read({ hasPendingCleanup: hasPendingMaintenance,
                                    onReady: (projection, isAccountCurrent) => {
                                        capturedCurrent = isAccountCurrent;
                                        if (isAccountCurrent()) publish(projection, isCurrent(), isAccountCurrent);
                                        published = getPublication();
                                        finishRead();
                                    },
                                }).then(projection => {
                                    if (!capturedCurrent || (capturedCurrent() && published === getPublication())) {
                                        publish(projection, isCurrent(), capturedCurrent ?? undefined);
                                    }
                                });
                                await Promise.race([ready, completion]);
                                if (capturedCurrent) return { maintenance: completion, isMaintenanceCurrent: capturedCurrent };
                            },
                        }));
                        // An independent foreground pass already serves the demand
                        // retained on older cleanup. Replaying it after this pass
                        // would mark the new cleanup dirty and self-trigger forever.
                        // A reader that joined the incumbent still owes that pass;
                        // wakes during this read remain in reloadAfterInFlight.
                        if (incumbentMaintenance && !joinedIncumbentMaintenance) {
                            incumbentMaintenance.reloadAfterMaintenance = false;
                        }
                        // A foreground reread can join cleanup already owned by this
                        // captured Account. Its short completion must not replace the
                        // original, still-running cleanup promise.
                        if (result && maintenance.get(target.key)?.result.isMaintenanceCurrent() !== true) {
                            // A wake can precede early publication and registration here.
                            const entry = { result, reloadAfterMaintenance: reloadAfterInFlight.has(target.key) };
                            maintenance.set(target.key, entry);
                            void result.maintenance.catch(() => {}).finally(async () => {
                                if (maintenance.get(target.key) !== entry) return;
                                maintenance.delete(target.key);
                                // Let an already-running foreground read decide whether it
                                // joined this cleanup or performed the demanded pass itself.
                                // Feeding cleanup completion back into its in-flight wake
                                // flag would make each new cleanup queue another reread.
                                await inFlight.get(target.key)?.catch(() => {});
                                if (entry.reloadAfterMaintenance && result.isMaintenanceCurrent()) {
                                    // Hand the existing debt to any newer cleanup first. Starting
                                    // another foreground read here would only join it and create
                                    // another final-proof completion, perpetuating the same debt.
                                    if (!requireMaintenanceReload(target)) void loadOnce(target).catch(() => {});
                                }
                            });
                        }
                    } catch (error) {
                        if (!lifetime.signal.aborted) failure = error;
                    }
                    if (!reloadAfterInFlight.delete(target.key)) {
                        if (failure !== null) throw failure;
                        return;
                    }
                    // The just-settled request began before the wake/gap. Keep any
                    // last-known answer visible, but never expose its capabilities
                    // as current while the deciding trailing read is pending.
                    params.invalidateTarget(target, 'reload');
                }
            } finally {
                // Delete the single-flight registration before this exact promise settles.
                // A wake/remount can then either mark the still-running loop for a trailing
                // read or start a new read; it cannot join a request that already chose to exit.
                if (inFlight.get(target.key) === pending) {
                    inFlight.delete(target.key);
                    if (!observed.has(target.key)) lifetimes.delete(target.key);
                    // A finite borrower can refresh without any wake subscription. Its answer
                    // stays valid for that invocation, but a later first observer must revalidate.
                    if (!observed.has(target.key) && !revalidateOnNextObserve.has(target.key)) {
                        revalidateOnNextObserve.set(target.key, 'finite-read');
                    }
                }
            }
        })();
        inFlight.set(target.key, pending);
        return pending;
    }

    function targetsForServer(serverId: string): TTarget[] {
        return [...observed.values()]
            .map((entry) => entry.target)
            .filter((target) => areServerProfileIdentifiersEquivalent(target.serverId, serverId));
    }

    function requestReload(target: TTarget): void {
        requireMaintenanceReload(target);
        if (inFlight.has(target.key)) {
            reloadAfterInFlight.add(target.key);
            return;
        }
        void loadOnce(target).catch(() => {});
    }

    function invalidate(target: TTarget): Promise<void> {
        const observedTarget = observed.get(target.key);
        if (observedTarget) observedTarget.target = target;
        params.invalidateTarget(target, 'explicit');
        requireMaintenanceReload(target);
        const existing = inFlight.get(target.key);
        if (existing) {
            reloadAfterInFlight.add(target.key);
            return existing;
        }
        return loadOnce(target);
    }

    function requireMaintenanceReload(target: TTarget): boolean {
        const incumbent = maintenance.get(target.key);
        if (incumbent?.result.isMaintenanceCurrent() === true) {
            // A changed demand can reveal new source/authority after this cleanup
            // started. Ordinary reads joining it do not schedule another pass.
            incumbent.reloadAfterMaintenance = true;
            return true;
        }
        return false;
    }

    function handleWake(event: HomeAccountChangeEvent): void {
        const targets = targetsForServer(event.serverId).filter(target => params.prepareWake?.(event, target) !== false);
        if (targets.length === 0) return;
        // Mark the exact Home's rows stale first, so a surface can explain
        // itself before the refetch answers. Other Homes are untouched.
        if (!params.prepareWake) params.invalidateServer(targets[0]!.serverId);
        for (const target of targets) {
            if (params.prepareWake) params.invalidateTarget(target, 'reload');
            requestReload(target);
        }
    }

    function ensureLifecycleSubscriptions(): void {
        if (!unsubscribeWake) {
            unsubscribeWake = subscribeHomeAccountChange((event) => {
                if (params.matchesWake && !params.matchesWake(event)) return;
                handleWake(event);
            }, { includeCatchUpPending: params.observeCatchUpPending });
        }
        if (params.onCredentialMutation && !unsubscribeCredentials) {
            unsubscribeCredentials = subscribeHomeCredentialChange((event) => {
                for (const target of targetsForServer(event.serverId)) {
                    if (params.onCredentialMutation?.(event, target) === true) {
                        requestReload(target);
                    }
                }
            });
        }
    }

    function releaseLifecycleSubscriptionsIfIdle(): void {
        if (observed.size > 0) return;
        unsubscribeWake?.();
        unsubscribeWake = null;
        unsubscribeCredentials?.();
        unsubscribeCredentials = null;
    }

    return {
        observe(target) {
            const entry = observed.get(target.key);
            const returnedAfterObserverGap = !entry && (revalidateOnNextObserve.delete(target.key) || inFlight.has(target.key));
            if (entry) {
                entry.count += 1;
            } else {
                observed.set(target.key, { target, count: 1 });
            }
            ensureLifecycleSubscriptions();

            if (returnedAfterObserverGap) {
                // This device heard no wakes while the target had no observer.
                // Retained rows remain useful, but their mutation decisions are
                // withdrawn synchronously before the remounted surface renders.
                params.invalidateTarget(target, 'observer-gap');
                requireMaintenanceReload(target);
            }
            if (returnedAfterObserverGap && inFlight.has(target.key)) {
                // Joining a read that began before the observer-free interval
                // would not prove currentness after that interval. Let it land
                // for continuity, then immediately revalidate once.
                reloadAfterInFlight.add(target.key);
            } else if (returnedAfterObserverGap || params.shouldLoadOnObserve(target)) {
                void loadOnce(target).catch(() => {});
            }

            let released = false;
            return () => {
                if (released) return;
                released = true;
                const tracked = observed.get(target.key);
                if (!tracked) return;
                tracked.count -= 1;
                if (tracked.count <= 0) {
                    observed.delete(target.key);
                    revalidateOnNextObserve.set(target.key, 'observer-gap');
                    // Once the last observer leaves, this device also stops
                    // listening for wakes for the target when no sibling keeps
                    // the shared lifecycle alive. Retain the rows for continuity,
                    // but withdraw their currentness immediately so synchronous
                    // readers cannot treat an unobserved projection as fresh.
                    params.invalidateTarget(target, 'observer-gap');
                    // No background read is useful without a consumer. The
                    // next first observer now owns the revalidation instead.
                    reloadAfterInFlight.delete(target.key);
                    lifetimes.get(target.key)?.abort();
                    lifetimes.delete(target.key);
                }
                releaseLifecycleSubscriptionsIfIdle();
            };
        },
        async refresh(target) {
            await loadOnce(target);
        },
        async invalidate(target) {
            await invalidate(target);
        },
        async readContinuation(target, read) {
            const lifetime = lifetimes.get(target.key) ?? new AbortController();
            lifetimes.set(target.key, lifetime);
            try {
                await read(lifetime.signal);
            } catch (error) {
                if (!lifetime.signal.aborted) throw error;
            } finally {
                if (!observed.has(target.key) && !inFlight.has(target.key) && lifetimes.get(target.key) === lifetime) {
                    lifetimes.delete(target.key);
                }
            }
        },
        resetForTests() {
            for (const lifetime of lifetimes.values()) lifetime.abort();
            lifetimes.clear();
            observed.clear();
            inFlight.clear();
            maintenance.clear();
            reloadAfterInFlight.clear();
            revalidateOnNextObserve.clear();
            unsubscribeWake?.();
            unsubscribeWake = null;
            unsubscribeCredentials?.();
            unsubscribeCredentials = null;
        },
    };
}
