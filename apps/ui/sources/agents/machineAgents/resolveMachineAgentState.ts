import type { MachineAgent, MachineAgentState } from './machineAgentTypes';
import { isNewerVersion } from '@/updates/items/updateItem';
import { resolveMachineAgentExecutionStateV1 } from '@happier-dev/protocol/capabilities/machineAgentInventory';

/** Readiness is derived here; consumers only choose how to present this state. */
export function resolveMachineAgentState(input: Pick<MachineAgent, 'installed' | 'platform' | 'signIn' | 'dependencies' | 'version' | 'latestVersion' | 'update' | 'job'> & Readonly<{
    known?: boolean;
    fit?: MachineAgent['fit'];
    checking?: boolean;
    /** Selected Provider authorization and compatibility, when that route is used. */
    credentialRouteReady?: boolean;
    /** Selected credential purposes override optional native authentication. */
    authenticationRequired?: boolean;
}>): MachineAgentState {
    if (input.job?.outcome === null) return 'installing';
    if (input.job?.outcome?.kind === 'failed' && input.job.outcome.code !== 'cancelled') return 'failed';
    const prerequisite = resolveMachineAgentExecutionStateV1(input);
    if (prerequisite !== 'ready') return prerequisite;
    if (input.update?.supported && input.version && input.latestVersion && isNewerVersion(input.version, input.latestVersion)) return 'updateAvailable';
    return 'ready';
}

export function isMachineAgentReady(agent: Pick<MachineAgent, 'state' | 'stale'> | null | undefined): boolean {
    return Boolean(agent && !agent.stale && (agent.state === 'ready' || agent.state === 'updateAvailable'));
}
