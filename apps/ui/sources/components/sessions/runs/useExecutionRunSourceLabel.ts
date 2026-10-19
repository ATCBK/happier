import * as React from 'react';
import type { ExecutionRunResolvedSelection } from '@happier-dev/protocol/execution/runs/requestedConfiguration';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { useProjectedQualifiedConnectedAccountTargetPresentations, type ProjectedQualifiedConnectedAccountTarget } from '@/hooks/server/connectedServices/useProjectedQualifiedConnectedAccountTargetPresentations';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { presentConnectedAccountPurposeTeamResource } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { resolveMachineRpcTargetServerId } from '@/sync/runtime/orchestration/serverScopedRpc/resolveMachineRpcTargetServerId';

/** Display the recorded route, never infer a current Account/pool member or authorize its use. */
export function useExecutionRunSourceLabel(
    selection: ExecutionRunResolvedSelection | undefined,
    serverId: string | null | undefined,
): string | null {
    const resolvedServerId = resolveMachineRpcTargetServerId(serverId) ?? null;
    const connectedServices = !selection?.modelSelection?.providerConnectionId && !selection?.teamCredentialModel
        ? selection?.connectedServices
        : null;
    const targets = React.useMemo(() => {
        const targets: ProjectedQualifiedConnectedAccountTarget[] = [];
        for (const [key, value] of Object.entries(connectedServices?.bindingsByServiceId ?? {})) {
            if (value.source !== 'connected') continue;
            const service = parseQualifiedPluginContributionKey(key);
            if (!service) continue;
            targets.push({ key, target: value.selection === 'group'
                ? { kind: 'group' as const, service, groupId: value.groupId }
                : { kind: 'account' as const, account: { service, accountId: value.profileId } } });
        }
        return targets;
    }, [connectedServices]);
    const { presentationsByKey } = useProjectedQualifiedConnectedAccountTargetPresentations(resolvedServerId, targets);
    const teamModel = selection?.teamCredentialModel;
    const teamCatalog = useHomeTeamCredentialModelCatalog({ serverId: resolvedServerId, enabled: teamModel !== undefined });
    if (teamModel) {
        return presentConnectedAccountPurposeTeamResource({
            teamResource: { teamId: teamModel.teamId, selection: teamModel },
            teamResources: teamCatalog.resources,
            teamNameById: teamCatalog.teamNameById,
            serviceTitle: null,
        }).accessibilityLabel;
    }
    const labels = [...new Set(targets.map(target => presentationsByKey[target.key]?.accessibilityLabel).filter(Boolean))];
    return labels.join(' · ') || null;
}
