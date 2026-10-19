import {
    composeSessionReadinessV1, isSessionReadinessNativeSelectionV1, type SessionCredentialReadinessV1, type SessionReadinessAgentV1,
    type SessionReadinessFactsV1, type SessionReadinessRepairV1, type SessionReadinessV1,
} from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import type { MachineAgent, MachineAgentSignInSession } from '@/agents/machineAgents/machineAgentTypes';
import type { MachineAgentsSnapshot } from '@/agents/machineAgents/machineAgentInventoryStore';
import { projectMachineAgentForCredential, type MachineAgentCredentialSelection } from '@/agents/machineAgents/machineAgentModel';
import { resolveMachineAgentStatus } from '@/components/machines/agents/machineAgentPresentation';
import { resolveMachineSpawnReadiness } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { resolveSessionHandoffStartReadiness } from '@/sync/domains/sessionHandoff/resolveSessionHandoffStartReadiness';
export { readSessionTeamCredentialReadiness, readSessionPersonalCredentialReadiness } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';

/** Projects the existing entitled repair without re-deciding credential or Agent readiness. */
export function readSessionReadinessRepair(readiness: SessionReadinessV1): SessionReadinessRepairV1 | null {
    return readiness.cause === 'agent' ? readiness.agent?.repair ?? null
        : readiness.cause === 'credential' && readiness.credential.kind === 'personal' ? readiness.credential.repair : null;
}

/**
 * People, the open Bot roster and Discussion picker consume this same data projection.
 * No reads, subscriptions, RPCs, writes or timers: their existing demand/batch owner supplies facts.
 */
export function buildSessionReadinessViewModel(input: Readonly<{
    configured: boolean;
    operation?: SessionReadinessFactsV1['operation'];
    machine: Parameters<typeof resolveMachineSpawnReadiness>[0];
    agent: MachineAgent | null;
    /** null means the Session's selected setup is not known; Account defaults cannot stand in for it. */
    selection: MachineAgentCredentialSelection | null;
    inventory: Pick<MachineAgentsSnapshot, 'status' | 'lastCheckedAt'>;
    signIn?: MachineAgentSignInSession | null;
    invocation: SessionReadinessFactsV1['invocation'];
    credential?: SessionCredentialReadinessV1;
    mayRepairAgent: boolean;
    handoff?: Parameters<typeof resolveSessionHandoffStartReadiness>[0];
}>) {
    const selectedAgent = input.selection ? projectMachineAgentForCredential(input.agent, input.selection) : null;
    const presented = resolveMachineAgentStatus(selectedAgent, input.signIn, input.inventory.status);
    const state: SessionReadinessAgentV1['state'] = presented.kind === 'ready' ? 'ready'
        : presented.kind === 'needsSignIn' || presented.kind === 'waitingForSignIn' ? 'needsSignIn'
        : presented.kind === 'notInstalled' || presented.kind === 'installing' || presented.kind === 'failed' ? 'notInstalled'
        : presented.kind === 'unsupported' ? 'unsupported'
        : presented.kind === 'checking' ? 'checking' : 'unknown';
    const nativeSelected = input.selection && !input.selection.providerRoute && isSessionReadinessNativeSelectionV1({
        metadata: { ...(input.selection.credentialBindings ? { connectedServices: input.selection.credentialBindings } : {}) },
        providerConnectionId: null,
    });
    const machineId = input.machine.selectedMachineId?.trim();
    const repair: SessionReadinessRepairV1 | null = presented.kind === 'needsSignIn' && nativeSelected
        && input.mayRepairAgent && machineId && selectedAgent?.signIn.nativeLogin === 'terminal'
        ? { actionId: 'machines.agents.signIn.start', input: { machineId, agentId: selectedAgent.agentId, method: 'native' } } : null;
    const readiness = composeSessionReadinessV1({ configured: input.configured,
        operation: input.operation ?? 'conversation', machine: input.machine.machine ? resolveMachineSpawnReadiness(input.machine)
            : machineId ? { status: 'unknown', machineId } : null,
        agent: selectedAgent ? { agentId: selectedAgent.agentId,
            ...(selectedAgent.definitionId ? { definitionId: selectedAgent.definitionId } : {}), state,
            current: !selectedAgent.stale && input.inventory.status === 'ready',
            observedAtMs: input.inventory.lastCheckedAt, repair } : null,
        invocation: input.invocation, credential: input.credential ?? { kind: 'not_required' } });
    return { readiness, repair: readSessionReadinessRepair(readiness),
        handoff: input.handoff ? resolveSessionHandoffStartReadiness(input.handoff) : null };
}
