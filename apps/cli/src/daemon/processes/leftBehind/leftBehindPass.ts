import type { createProcessOwnershipRuntime } from '../ownership/processOwnershipRuntime';
import { processOwnerKey, type ProcessOwnerRef } from '../ownership/types';
import { createLeftBehindTracker } from './leftBehindTracker';

export function createLeftBehindPass(input: Readonly<{
    processOwnershipRuntime: ReturnType<typeof createProcessOwnershipRuntime>;
    onUnavailable?: (reason: string) => void;
}>) {
    const tracker = createLeftBehindTracker();
    const timers = new Map<string, NodeJS.Timeout>();
    let disposed = false;
    const observeView = (view: Awaited<ReturnType<typeof input.processOwnershipRuntime.readOwners>>) => {
        if (disposed) return { status: 'unavailable' as const, reason: 'disposed' };
        if (view.status !== 'ok') { input.onUnavailable?.(view.reason); return view; }
        tracker.observe({ status: 'ok', capturedAtMs: view.snapshot.capturedAtMs, rows: view.rows });
        const owners = new Map<string, ProcessOwnerRef>();
        for (const row of view.rows) if (row.owner && row.level === 'left_behind' && row.ownerEnded) owners.set(processOwnerKey(row.owner), row.owner);
        for (const [key, timer] of timers) {
            const owner = owners.get(key);
            if (!owner || tracker.nextConfirmationAtMs(owner) === undefined) { clearTimeout(timer); timers.delete(key); }
        }
        return { status: 'ok' as const, owners, capturedAtMs: view.snapshot.capturedAtMs };
    };
    const observeFresh = async () => observeView(await input.processOwnershipRuntime.readOwners({ freshness: 'fresh', requesterAttribution: 'retained' }));
    const scheduleConfirmation = (owner: ProcessOwnerRef, capturedAtMs: number) => {
        const key = processOwnerKey(owner);
        const at = tracker.nextConfirmationAtMs(owner);
        if (disposed || at === undefined || timers.has(key)) return;
        const timer = setTimeout(() => {
            timers.delete(key);
            void observeFresh().then(observation => {
                if (observation.status === 'ok' && observation.owners.has(key)) {
                    scheduleConfirmation(owner, observation.capturedAtMs);
                }
            }).catch(() => input.onUnavailable?.('read_failed'));
        }, Math.max(0, at - capturedAtMs));
        timer.unref();
        timers.set(key, timer);
    };
    const firstPass = async (owner?: ProcessOwnerRef) => {
        if (disposed) return;
        const observation = await observeFresh();
        if (observation.status !== 'ok') return;
        const owners = observation.owners;
        const keys = owner ? [processOwnerKey(owner)] : [...owners.keys()];
        for (const key of keys) {
            const candidateOwner = owners.get(key);
            if (candidateOwner) scheduleConfirmation(candidateOwner, observation.capturedAtMs);
        }
    };
    return {
        firstPass,
        /** A watched census is already native evidence; never resample it merely to update confirmation. */
        observe(view: Awaited<ReturnType<typeof input.processOwnershipRuntime.readOwners>>) {
            const observation = observeView(view);
            if (observation.status === 'ok') for (const owner of observation.owners.values()) scheduleConfirmation(owner, observation.capturedAtMs);
        },
        async readConfirmed() {
            const observation = await observeFresh();
            return observation.status === 'ok' ? { status: 'ok' as const, items: tracker.confirmed() } : observation;
        },
        confirmed: tracker.confirmed,
        dispose() { disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
    };
}
