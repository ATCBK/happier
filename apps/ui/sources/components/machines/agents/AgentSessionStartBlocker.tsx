import * as React from 'react';

import type { MachineAgent } from '@/agents/machineAgents/machineAgentTypes';
import { AttentionBanner, type AttentionBannerAction } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';

import { resolveAgentSessionStartBlock } from './machineAgentPresentation';


export const AgentSessionStartBlocker = React.memo(function AgentSessionStartBlocker(props: Readonly<{
    agent: MachineAgent | null;
    machineName: string;
    /** Omitted while the consumer's setup destination is unresolved; keep the blocker visible. */
    onSetUp?: (agent: MachineAgent) => void;
    connectedServicesRecoveryAction?: AttentionBannerAction | null;
}>) {
    const block = resolveAgentSessionStartBlock(props.agent);
    if (!block || !props.agent) return null;
    const agent = props.agent;
    const setUp: AttentionBannerAction = {
        label: block === 'notInstalled' ? t('machineAgents.setUp') : t('machineAgents.actionSignIn'),
        onPress: () => props.onSetUp?.(agent),
        disabled: !props.onSetUp,
        testID: 'new-session-agent-blocker.action',
    };
    const recovery = block === 'signedOut' ? props.connectedServicesRecoveryAction ?? null : null;
    return (
        <AttentionBanner
            testID="new-session-agent-blocker"
            tone="warning"
            title={block === 'notInstalled'
                ? t('machineAgents.blockNotInstalled', { agent: agent.title, machine: props.machineName })
                : t('machineAgents.blockSignedOut', { agent: agent.title, machine: props.machineName })}
            description={block === 'notInstalled' ? t('machineAgents.blockSetUpToStart') : undefined}
            // A healthy connected account is one tap and immediate, so it leads; setting up or signing in
            // natively stays as the second way forward. Every blocker state keeps its actions in one place.
            action={recovery ?? setUp}
            secondaryAction={recovery ? setUp : null}
            actionPlacement="below"
        />
    );
});
