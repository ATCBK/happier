import { createProcessCensusReader, readProcessCensus, type ProcessCensusDependencies, type ProcessCensusFreshness, type ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { resolveProcessOwnership } from './resolveProcessOwnership';
import type { HappierProcessRoot, ListenerFact } from './types';

/** Consumer-owned demand calls the one census/ownership path; no successful table is retained. */
export function createProcessOwnershipRuntime(input: Readonly<{
    listRoots(snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>): readonly HappierProcessRoot[] | Promise<readonly HappierProcessRoot[]>;
    daemonScopeKey: string;
    selfPid?: number;
    platform?: NodeJS.Platform;
    listeners?: () => readonly ListenerFact[];
    /** Genuine OS boundary injection for composed lifecycle tests. */
    censusDependencies?: ProcessCensusDependencies;
}>) {
    const census = input.censusDependencies ? createProcessCensusReader(input.censusDependencies) : readProcessCensus;
    const resolveSnapshot = async (snapshot: Extract<ProcessCensusSnapshot, { status: 'ok' }>, listeners = input.listeners?.()) => {
        let roots: readonly HappierProcessRoot[];
        try { roots = await input.listRoots(snapshot); }
        catch { return { status: 'unavailable' as const, reason: 'read_failed' as const }; }
        const rows = resolveProcessOwnership({ snapshot, roots,
            daemonPrincipal: snapshot.rows.find(row => row.pid === (input.selfPid ?? process.pid))?.principal ?? null,
            daemonScopeKey: input.daemonScopeKey, platform: input.platform, listeners });
        return { status: 'ok' as const, snapshot, roots, rows };
    };
    return {
        resolveSnapshot,
        async readOwners(request: Readonly<{ freshness: ProcessCensusFreshness }>) {
            const snapshot = await census({ freshness: request.freshness, scope: 'all' });
            if (snapshot.status !== 'ok') return snapshot;
            return resolveSnapshot(snapshot);
        },
        async readProcessMetrics(pids: readonly number[]) {
            return census({ freshness: 'shared', scope: 'all', pids, fields: ['memory', 'cpuTimeUs'] });
        },
    };
}
