import type { AgentInputControlDescriptor, AgentInputHostControlId } from './agentInputControlTypes';

/**
 * Rail order (owner, 2026-10-12): rail 1 reads as setup — the small attachment controls (paperclip, @),
 * then engine/model, permission, mode, the route it runs through, launch profile/environment, then the
 * rest (sharing, tags, ...). Rail 2 is where it runs — machine, folder, resume — then the Git checkout,
 * the session-list folder (`organization`), and automation.
 */
export const AGENT_INPUT_CONTROL_REGISTRY = [
    { id: 'attachments', line: 'primary' },
    { id: 'files', line: 'primary' },
    { id: 'linkedFiles', line: 'primary' },
    { id: 'engine', line: 'primary' },
    { id: 'permission', line: 'primary' },
    { id: 'mode', line: 'primary' },
    { id: 'connectedServices', line: 'primary' },
    { id: 'profile', line: 'primary' },
    { id: 'env', line: 'primary' },
    // Stop leads "the rest", so a running turn's stop never hides behind the rail's scroll.
    { id: 'stop', line: 'primary' },
    { id: 'goal', line: 'primary' },
    { id: 'workflow', line: 'primary' },
    { id: 'workflowInputs', line: 'primary' },
    { id: 'workflowRoles', line: 'primary' },
    { id: 'workflowTargets', line: 'primary' },
    { id: 'server', line: 'primary' },
    { id: 'capabilities', line: 'primary' },
    { id: 'sessionAccess', line: 'primary' },
    { id: 'tags', line: 'primary' },
    { id: 'recipient', line: 'primary' },
    { id: 'delivery', line: 'primary' },
    { id: 'reviewComments', line: 'primary' },
    { id: 'storage', line: 'primary' },
    { id: 'windowsRemoteSessionMode', line: 'primary' },
    { id: 'providerOption', line: 'primary' },
    { id: 'shortcuts', line: 'primary' },
    { id: 'actionMenu', line: 'primary' },
    { id: 'machine', line: 'secondary' },
    { id: 'path', line: 'secondary' },
    { id: 'resume', line: 'secondary' },
    { id: 'checkout', line: 'secondary' },
    { id: 'organization', line: 'secondary' },
    { id: 'automation', line: 'secondary' },
] as const satisfies ReadonlyArray<AgentInputControlDescriptor>;

/**
 * The compact composer (an "Ask an agent" box on a page about one machine, lab `ra` A1): where it runs
 * and which model answers, on one rail. Everything else keeps its default for the new session.
 */
export const AGENT_INPUT_COMPACT_CONTROL_IDS = ['engine', 'machine'] as const satisfies readonly AgentInputHostControlId[];

export function findAgentInputControlDescriptor(id: AgentInputHostControlId): AgentInputControlDescriptor | null {
    return AGENT_INPUT_CONTROL_REGISTRY.find((control) => control.id === id) ?? null;
}
