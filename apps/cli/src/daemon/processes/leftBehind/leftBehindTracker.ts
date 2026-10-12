import { processOwnerKey, type ProcessOwnerRef, type ResolvedProcessOwnership } from '../ownership/types';
import { processRef } from '../view/processRef';

export const LEFT_BEHIND_CONFIRMATION_INTERVAL_MS = 60_000;
export type LeftBehindItem = Readonly<{
    pid: number; start: ResolvedProcessOwnership['start']; owner: ProcessOwnerRef;
    ref: string; firstSeenAtMs: number; confirmedAtMs: number;
}>;
export type LeftBehindObservation =
    | Readonly<{ status: 'ok'; capturedAtMs: number; rows: readonly ResolvedProcessOwnership[] }>
    | Readonly<{ status: 'unavailable'; reason: string }>;

export function createLeftBehindTracker() {
    let candidates = new Map<string, Omit<LeftBehindItem, 'confirmedAtMs'> & { confirmedAtMs?: number }>();
    return {
        observe(observation: LeftBehindObservation): void {
            if (observation.status !== 'ok') return;
            const next: typeof candidates = new Map();
            for (const row of observation.rows) {
                if (row.level !== 'left_behind' || !row.owner || !row.ownerEnded) continue;
                const ref = processRef(row.pid, row.start);
                const key = `${processOwnerKey(row.owner)}:${ref}`;
                const prior = candidates.get(key);
                const item = prior ?? { pid: row.pid, start: row.start, owner: row.owner, ref, firstSeenAtMs: observation.capturedAtMs };
                const confirmedAtMs = item.confirmedAtMs ?? (prior && observation.capturedAtMs - prior.firstSeenAtMs >= LEFT_BEHIND_CONFIRMATION_INTERVAL_MS
                    ? observation.capturedAtMs : undefined);
                next.set(key, { ...item, ...(confirmedAtMs === undefined ? {} : { confirmedAtMs }) });
            }
            candidates = next;
        },
        confirmed(): readonly LeftBehindItem[] {
            return [...candidates.values()].flatMap(item => item.confirmedAtMs === undefined ? [] : [{ ...item, confirmedAtMs: item.confirmedAtMs }]);
        },
        nextConfirmationAtMs(owner: ProcessOwnerRef): number | undefined {
            const key = processOwnerKey(owner);
            let next: number | undefined;
            for (const item of candidates.values()) {
                if (item.confirmedAtMs !== undefined || processOwnerKey(item.owner) !== key) continue;
                const at = item.firstSeenAtMs + LEFT_BEHIND_CONFIRMATION_INTERVAL_MS;
                next = next === undefined ? at : Math.min(next, at);
            }
            return next;
        },
    };
}
