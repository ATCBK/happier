import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import type { SessionInstrumentStripLineAction } from '@/components/sessions/agentInput/instrumentStrip';
import { t } from '@/text';

import { resolveAgentSessionStartBlock } from './machineAgentPresentation';

/** The composer's one-line state when the chosen agent cannot start on the chosen machine, with its ways forward. */
export type AgentSessionStartBlockLine = Readonly<{
    text: string;
    /** The longer reason behind the short sentence (shown as the line's tooltip). */
    detail?: string;
    action: SessionInstrumentStripLineAction;
    secondaryAction?: SessionInstrumentStripLineAction;
}>;

/**
 * Why the chosen agent can't start on the chosen machine, said once on the composer's status line (lab
 * `agent-setup` ST "session start"). Not on the machine → Set up; signed out → a healthy connected
 * account's one-tap switch leads and Sign in is the second way forward. Null when the agent can start.
 */
export function resolveAgentSessionStartBlockLine(params: Readonly<{
    agent: MachineAgent | null;
    machineName: string;
    /** Omitted while the consumer's setup destination is unresolved; the action stays visible but disabled. */
    onSetUp?: (agent: MachineAgent) => void;
    connectedServicesRecoveryAction?: SessionInstrumentStripLineAction | null;
}>): AgentSessionStartBlockLine | null {
    const block = resolveAgentSessionStartBlock(params.agent);
    const agent = params.agent;
    if (!block || !agent) return null;
    const setUp: SessionInstrumentStripLineAction = {
        label: block === 'notInstalled' ? t('machineAgents.setUp') : t('machineAgents.actionSignIn'),
        onPress: () => params.onSetUp?.(agent),
        disabled: !params.onSetUp,
        testID: 'new-session-agent-blocker.action',
    };
    const recovery = block === 'signedOut' ? params.connectedServicesRecoveryAction ?? null : null;
    if (block === 'signedOut' && agent.signIn.connectedAccountFailure) {
        return {
            text: t('connectedServices.diagnostics.status.connected_service_credential_reconnect_required'),
            detail: t('connectedServices.diagnostics.body.connected_service_credential_reconnect_required'),
            action: recovery ?? { ...setUp, label: t('connectedServices.detail.actions.reconnect'), disabled: true },
        };
    }
    return {
        // The line says the cause once and short (it stays one line on a phone, where the machine chip sits
        // right below it); which machine, and what to do about it, is its detail.
        text: block === 'notInstalled'
            ? t('machineAgents.blockNotInstalledShort', { agent: agent.title })
            : t('machineAgents.blockSignedOutShort', { agent: agent.title }),
        detail: block === 'notInstalled'
            ? `${t('machineAgents.blockNotInstalled', { agent: agent.title, machine: params.machineName })} ${t('machineAgents.blockSetUpToStart')}`
            : t('machineAgents.blockSignedOut', { agent: agent.title, machine: params.machineName }),
        // A healthy connected account is one tap and immediate, so it leads; setting up or signing in
        // natively stays as the second way forward.
        action: recovery ?? setUp,
        secondaryAction: recovery ? setUp : undefined,
    };
}
