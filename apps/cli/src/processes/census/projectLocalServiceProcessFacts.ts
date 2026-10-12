import { readProcessCensus } from '@/processes/census/processCensus';
import { censusRowToProcessFact } from '@/processes/census/processFacts';
import { indexCensus } from '@/processes/tree/processTree';
import type { LocalServiceProcessFact } from '@/daemon/local/services/inventory/provenance';

/** Socket enrichment projects the canonical census; ownership is resolved by the daemon owner. */
export async function projectLocalServiceProcessFacts(input: Readonly<{
    seedPids: readonly number[];
    onReadFailure?: () => void;
}>): Promise<ReadonlyMap<number, LocalServiceProcessFact>> {
    const snapshot = await readProcessCensus({ freshness: 'shared', scope: 'all',
        fields: ['argv', 'cwd', 'ownershipEnvironment', 'cgroup'], commandRoots: input.seedPids });
    if (snapshot.status !== 'ok') {
        input.onReadFailure?.();
        return new Map();
    }
    const index = indexCensus(snapshot.rows);
    const selfPrincipal = index.byPid.get(process.pid)?.principal ?? null;
    const processes = new Map<number, LocalServiceProcessFact>();
    const missingByPid = new Map(snapshot.partial?.map(item => [item.pid, item.missing]) ?? []);
    for (const row of snapshot.rows) {
        const missing = missingByPid.get(row.pid);
        processes.set(row.pid, { ...censusRowToProcessFact(row, selfPrincipal), ...(missing ? { censusMissing: missing } : {}) });
    }
    return processes;
}
