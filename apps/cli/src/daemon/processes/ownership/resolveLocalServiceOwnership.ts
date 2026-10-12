import type { ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { processFactToCensusRow } from '@/processes/classification/projectProcessLineage';
import type { LocalServiceProcessFact } from '@/daemon/local/services/inventory/provenance';
import type { TerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { resolveProcessOwnership } from './resolveProcessOwnership';
import type { ListenerFact, ResolvedProcessOwnership } from './types';

/** Existing fact adapters retain census rows; legacy explicit principal facts stay boundary inputs. */
export function localServiceFactsSnapshot(processes: ReadonlyMap<number, LocalServiceProcessFact>, capturedAtMs: number): Extract<ProcessCensusSnapshot, { status: 'ok' }> {
    const rows = [...processes.values()].map(fact => {
        if (fact.censusRow) return fact.censusRow;
        const row = processFactToCensusRow(fact);
        return { ...row, principal: fact.processOwnership === undefined ? null
            : { kind: 'uid' as const, value: fact.processOwnership === 'self' ? 'daemon' : 'other' } };
    });
    const partial = [...processes.values()].flatMap(fact => fact.censusMissing ? [{ pid: fact.pid, missing: fact.censusMissing }] : []);
    return { status: 'ok', capturedAtMs, logicalCpus: 1, rows, ...(partial.length ? { partial } : {}) };
}

export function resolveLocalServiceOwnership(input: Readonly<{
    processes: ReadonlyMap<number, LocalServiceProcessFact>; now: number;
    terminalRegistry?: TerminalProcessRegistry; listeners: readonly ListenerFact[];
}>): readonly ResolvedProcessOwnership[] {
    const snapshot = localServiceFactsSnapshot(input.processes, input.now);
    const roots = listHappierProcessRoots({ snapshot, terminalRegistry: input.terminalRegistry });
    const daemonPrincipal = snapshot.rows.find(row => row.pid === process.pid)?.principal
        ?? snapshot.rows.find(row => row.principal?.value === 'daemon')?.principal ?? null;
    return resolveProcessOwnership({ snapshot, roots, daemonPrincipal, listeners: input.listeners });
}
