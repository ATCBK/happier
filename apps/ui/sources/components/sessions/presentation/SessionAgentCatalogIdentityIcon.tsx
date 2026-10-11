import * as React from 'react';

import { useSessionAgentCatalogIdentity } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';

/** Session-chrome adapter onto the canonical machine-scoped Agent catalog. */
export function SessionAgentCatalogIdentityIcon(props: Readonly<{
    agentId: string;
    machineId: string | null;
    serverId: string | null;
    color?: string;
    size?: number;
    testID?: string;
}>): React.ReactElement {
    const { entry, current } = useSessionAgentCatalogIdentity({
        agentId: props.agentId,
        machineId: props.machineId,
        serverId: props.serverId,
    });

    return (
        <AgentCatalogIdentityIcon
            entry={entry}
            machineId={props.machineId}
            serverId={props.serverId}
            current={current}
            color={props.color}
            size={props.size}
            testID={props.testID}
        />
    );
}
