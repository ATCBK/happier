import * as React from 'react';
import type { ExecutionRunResolvedSelection } from '@happier-dev/protocol/execution/runs/requestedConfiguration';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { useProjectedConnectedServicesRegistry, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import { useQualifiedConnectedAccountTargetPresentations, type QualifiedConnectedAccountPresentationTarget } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountTargetPresentations';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { presentConnectedAccountPurposeTeamResource } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { resolveMachineRpcTargetServerId } from '@/sync/runtime/orchestration/serverScopedRpc/resolveMachineRpcTargetServerId';
import { t } from '@/text';

/** Display the recorded route, never infer a current Account/pool member or authorize its use. */
export function useExecutionRunSourceLabel(
    selection: ExecutionRunResolvedSelection | undefined,
    serverId: string | null | undefined,
): string | null {
    const resolvedServerId = resolveMachineRpcTargetServerId(serverId) ?? null;
    const connectedServices = !selection?.modelSelection?.providerConnectionId && !selection?.teamCredentialModel
        ? selection?.connectedServices
        : null;
    const hasConnectedTargets = Object.values(connectedServices?.bindingsByServiceId ?? {}).some(value => value.source === 'connected');
    const requestedServerIds = React.useMemo(() => hasConnectedTargets && resolvedServerId ? [resolvedServerId] : [], [hasConnectedTargets, resolvedServerId]);
    const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    const activeScope = useActiveServerAccountScope();
    const registry = useProjectedConnectedServicesRegistry();
    const localize = useProjectedPluginLocalizedTextResolver();
    const registryMatchesScope = binding !== null && areServerAccountScopesEqual(binding.scope, activeScope);
    const targets = React.useMemo(() => {
        const targets: QualifiedConnectedAccountPresentationTarget[] = [];
        for (const [key, value] of Object.entries(connectedServices?.bindingsByServiceId ?? {})) {
            if (value.source !== 'connected') continue;
            const service = parseQualifiedPluginContributionKey(key);
            if (!service) continue;
            const target = value.selection === 'group'
                ? { kind: 'group' as const, service, groupId: value.groupId }
                : { kind: 'account' as const, account: { service, accountId: value.profileId } };
            targets.push({ key, target,
                serviceTitle: resolveQualifiedConnectedServiceRegistryDisplayName(
                    registryMatchesScope ? registry : { entries: [] }, service, t,
                    registryMatchesScope ? localize : undefined,
                ),
            });
        }
        return targets;
    }, [connectedServices, localize, registry, registryMatchesScope]);
    const { presentationsByKey } = useQualifiedConnectedAccountTargetPresentations({ binding, targets });
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
