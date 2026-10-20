import { createProcessCensusReader, readProcessCensus, type ProcessCensusDependencies, type ProcessCensusFreshness, type ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { resolveProcessOwnership } from './resolveProcessOwnership';
import type { HappierProcessRoot, ListenerFact } from './types';
import { logger } from '@/ui/logger';

/** Physical custody needs retained lifecycle facts, never Account recovery. */
type ProcessOwnershipReadOptions = Readonly<{ requesterAttribution?: 'retained' }>;

/** Consumer-owned demand calls the one census/ownership path; no successful table is retained. */
export function createProcessOwnershipRuntime(input: Readonly<{
    listRoots(snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>, options: ProcessOwnershipReadOptions): readonly HappierProcessRoot[] | Promise<readonly HappierProcessRoot[]>;
    daemonScopeKey: string;
    selfPid?: number;
    platform?: NodeJS.Platform;
    listeners?: () => readonly ListenerFact[];
    /** Genuine OS boundary injection for composed lifecycle tests. */
    censusDependencies?: ProcessCensusDependencies;
}>) {
    const census = input.censusDependencies ? createProcessCensusReader(input.censusDependencies) : readProcessCensus;
    async function observe<T>(phase: string, operation: () => T | Promise<T>, capturedAtMs?: number): Promise<T> {
        const startedAtMs = Date.now();
        logger.debug('[process-ownership] Observation phase started', { phase, capturedAtMs });
        try { return await operation(); }
        finally { logger.debug('[process-ownership] Observation phase settled', { phase, capturedAtMs, elapsedMs: Date.now() - startedAtMs }); }
    }
    const resolveSnapshot = async (snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>, listeners = input.listeners?.(), options: ProcessOwnershipReadOptions = {}) => {
        let roots: readonly HappierProcessRoot[];
        try { roots = await observe('lifecycle_roots', () => input.listRoots(snapshot, options), snapshot.capturedAtMs); }
        catch { return { status: 'unavailable' as const, reason: 'read_failed' as const }; }
        const rows = await observe('ownership_resolution', () => resolveProcessOwnership({ snapshot, roots,
            daemonPrincipal: snapshot.rows.find(row => row.pid === (input.selfPid ?? process.pid))?.principal ?? null,
            daemonScopeKey: input.daemonScopeKey, platform: input.platform, listeners }), snapshot.capturedAtMs);
        logger.debug('[process-ownership] Observation resolved', { capturedAtMs: snapshot.capturedAtMs,
            processCount: snapshot.rows.length, rootCount: roots.length, requesterAttribution: options.requesterAttribution ?? 'recover' });
        return { status: 'ok' as const, snapshot, roots, rows };
    };
    return {
        resolveSnapshot,
        async readOwners(request: Readonly<{ freshness: ProcessCensusFreshness }> & ProcessOwnershipReadOptions) {
            const snapshot = await observe('native_census', () => census({ freshness: request.freshness, scope: 'all' }));
            if (snapshot.status !== 'ok') return snapshot;
            return resolveSnapshot(snapshot, undefined, request);
        },
        async readProcessMetrics(pids: readonly number[]) {
            return census({ freshness: 'shared', scope: 'all', pids, fields: ['memory', 'cpuTimeUs'] });
        },
    };
}
