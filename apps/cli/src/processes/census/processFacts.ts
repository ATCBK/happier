import type { LocalServiceProcessFact } from '@/daemon/local/services/inventory/provenance';
import { classifyProcessOwnershipByIdentity } from '@/processes/ownership/principal';
import type { ProcessCensusRow, ProcessPrincipal } from './processCensus';

/** Compatibility projection for existing identity/reader callers; the census owns every observation. */
export type ProcessCensusProcessFact = LocalServiceProcessFact & Readonly<{
    name?: string; executablePath?: string; ownerSid?: string; currentUserSid?: string;
}>;

export function censusRowToProcessFact(row: ProcessCensusRow, selfPrincipal: ProcessPrincipal | null = null): ProcessCensusProcessFact {
    const command = (row.commandLine ?? row.argv?.join(' ') ?? '').trim();
    const comparable = row.principal !== null && selfPrincipal !== null && row.principal.kind === selfPrincipal.kind;
    const processOwnership = classifyProcessOwnershipByIdentity(
        comparable ? row.principal?.value : undefined,
        comparable ? selfPrincipal?.value : undefined,
    );
    return {
        censusRow: row, pid: row.pid, ...(row.ppid !== null && row.ppid > 0 ? { ppid: row.ppid } : {}),
        processStartTimeMs: row.start.startTimeMs, command: command.toLowerCase() === 'unknown' ? '' : command,
        name: row.name, ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
        ...(row.executablePath !== undefined ? { executablePath: row.executablePath } : {}),
        ...(processOwnership ? { processOwnership } : {}),
        ...(row.principal?.kind === 'sid' ? { ownerSid: row.principal.value } : {}),
        ...(selfPrincipal?.kind === 'sid' ? { currentUserSid: selfPrincipal.value } : {}),
    };
}
