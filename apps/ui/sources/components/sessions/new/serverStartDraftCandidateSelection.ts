import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveExactServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachines';
import { normalizeLocalPathForComparison } from '@/utils/path/resolvePathRelativeToRoot';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { getMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

import type {
    SessionServerStartDraftSeed,
    SessionServerStartDraftTarget,
} from './serverStartDraftComposer';

type Candidate = NonNullable<SessionServerStartDraftSeed['candidates']>[number];

export function resolveSessionServerStartCandidateSelection(params: Readonly<{
    mountedTarget: SessionServerStartDraftTarget;
    accountScope?: MachineReachabilityScope | null;
    selectedCandidate?: Candidate;
    activeServerId: string;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>): Readonly<{
    candidate?: Candidate;
    target: SessionServerStartDraftTarget;
    machine: Machine | null;
    directory?: string;
    machineReady: boolean;
}> {
    const target = params.selectedCandidate === undefined
        ? params.mountedTarget
        : {
            serverId: params.selectedCandidate.serverId,
            machineId: params.selectedCandidate.machineId,
        };
    const machine = resolveExactServerScopedMachine({
        machineId: target.machineId,
        serverId: target.serverId,
        activeServerId: params.activeServerId,
        activeMachines: params.activeMachines,
        machineListByServerId: params.machineListByServerId,
        machineListStatusByServerId: params.machineListStatusByServerId,
    });

    return {
        ...(params.selectedCandidate === undefined ? {} : { candidate: params.selectedCandidate }),
        target,
        machine,
        ...(params.selectedCandidate === undefined ? {} : { directory: params.selectedCandidate.rootPath }),
        machineReady: resolveMachineSpawnReadiness({
            machine,
            selectedMachineId: target.machineId,
            scope: selectActiveServerAccountScopeForServer(params.accountScope ?? null, target.serverId),
        }).status === 'ready',
    };
}

/**
 * The candidate the working directory currently stands for: same Home and Machine as the chosen target, same
 * folder. A folder typed or browsed to that no candidate names selects none, while the chosen Machine and Home stay
 * the target; the checkout rows never claim a directory the reader moved away from.
 */
export function findSessionServerStartCandidateForDirectory(params: Readonly<{
    candidates: readonly Candidate[] | undefined;
    target: SessionServerStartDraftTarget;
    directory: string;
}>): number {
    const directory = normalizeLocalPathForComparison(params.directory);
    if (directory === null || params.candidates === undefined) return -1;
    return params.candidates.findIndex((candidate) => (
        candidate.serverId === params.target.serverId
        && candidate.machineId === params.target.machineId
        && normalizeLocalPathForComparison(candidate.rootPath) === directory
    ));
}

/**
 * What a placement candidate row says: the folder (its label, else its path relative to the
 * machine's home) and the machine's name. Raw machine and server ids are never shown; a machine this
 * device cannot resolve simply goes unnamed.
 */
export function presentSessionServerStartCandidate(params: Readonly<{
    candidate: Candidate;
    activeServerId: string;
    activeMachines: readonly Machine[];
    machineListByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>): Readonly<{ title: string; subtitle: string | undefined }> {
    const machine = resolveExactServerScopedMachine({
        machineId: params.candidate.machineId,
        serverId: params.candidate.serverId,
        activeServerId: params.activeServerId,
        activeMachines: params.activeMachines,
        machineListByServerId: params.machineListByServerId,
        machineListStatusByServerId: params.machineListStatusByServerId,
    });
    return {
        title: params.candidate.label
            ?? formatSessionPath(params.candidate.rootPath, machine?.metadata?.homeDir ?? undefined),
        subtitle: getMachineDisplayName(machine) ?? undefined,
    };
}
