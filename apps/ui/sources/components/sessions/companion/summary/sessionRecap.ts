/**
 * The Summary card's Recap row (ORC §3.8, D-I): where this Session's work stands, in one line.
 *
 * It reads what already exists and runs nothing: the memory worker's latest `session_synopsis.v1` when
 * memory is on and has produced one, otherwise the headline of the latest update a worker delivered to this
 * Session. There is no summarizer, cache, character window or setting of its own — when neither
 * exists, there is no Recap.
 */

export type SessionRecapSynopsis = Readonly<{ synopsis: string; seqTo: number; updatedAtMs: number }>;

export type SessionRecapWorkerUpdate = Readonly<{ headline: string; atMs: number }>;

export type SessionRecap =
    | Readonly<{ source: 'synopsis'; text: string; atMs: number }>
    | Readonly<{ source: 'worker_update'; text: string; atMs: number }>;

function readText(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

export function resolveSessionRecap(input: Readonly<{
    memoryEnabled: boolean;
    /** Every synopsis record the memory worker wrote for this Session (any order). */
    synopses: readonly SessionRecapSynopsis[];
    latestWorkerUpdate: SessionRecapWorkerUpdate | null;
}>): SessionRecap | null {
    let latest: SessionRecapSynopsis | null = null;
    for (const synopsis of input.memoryEnabled ? input.synopses : []) {
        if (!readText(synopsis.synopsis)) continue;
        if (!latest || synopsis.seqTo > latest.seqTo || (synopsis.seqTo === latest.seqTo && synopsis.updatedAtMs > latest.updatedAtMs)) {
            latest = synopsis;
        }
    }
    if (latest) return { source: 'synopsis', text: readText(latest.synopsis) as string, atMs: latest.updatedAtMs };
    const headline = readText(input.latestWorkerUpdate?.headline);
    if (headline && input.latestWorkerUpdate) {
        return { source: 'worker_update', text: headline, atMs: input.latestWorkerUpdate.atMs };
    }
    return null;
}
