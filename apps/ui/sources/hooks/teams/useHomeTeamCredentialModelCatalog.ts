import * as React from 'react';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams';
import type { ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { projectAgentProviderBrokerApplications } from '@happier-dev/protocol/providers/catalog/brokerApplicationProjectionV1';
import { parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { teamsUnavailableReason, type TeamsDirectoryUnavailableHome } from '@/components/settings/teams/teamsDirectoryViewState';

import { observeTeamCredentialResourceCatalog, refreshTeamCredentialResourceCatalog } from '@/sync/engine/teams/teamsDirectoryEngine';
import { getTeamCredentialResourceCatalogSnapshot, subscribeTeamsSnapshots } from '@/sync/store/teams/teamsSnapshots';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { readAccountAgentProviderRequirements, readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { useTeamsDirectory } from './useTeamsDirectory';

export type HomeTeamCredentialModelCatalog = Readonly<{
    resources: readonly TeamCredentialResourceCatalogEntryV1[];
    teamNameById: Readonly<Record<string, string>>;
    homeNameByTeamId: Readonly<Record<string, string>>;
    currentResourceKeys: ReadonlySet<string>;
    current: boolean;
    /** The owning directory/catalog's cold-load or failed-read condition, never inferred from emptiness. */
    condition: Pick<TeamsDirectoryUnavailableHome, 'reason' | 'retryable'> | null;
    /** Re-reads membership discovery and observed Team catalogs through their canonical engine. */
    reload: () => Promise<void>;
}>;

const EMPTY_RESOURCES: readonly TeamCredentialResourceCatalogEntryV1[] = Object.freeze([]);
const ADMITTED_PROVIDERS = readAccountProviderDeclarations().flatMap(declaration => {
    const parsed = parseProviderContributionIdentityV1(declaration.contributionKey);
    return parsed ? [{ identity: parsed.identity, definition: declaration.definition }] : [];
});

/**
 * Recipient-safe model catalog for the exact Home selected by Session authoring.
 * The Team directory owns membership discovery and each Team resource loader
 * owns eligibility/currentness; this hook only composes their projections.
 */
export function useHomeTeamCredentialModelCatalog(input: Readonly<{
    serverId: string | null | undefined;
    enabled: boolean;
    /** Omission requests generic resource discovery, without Agent model projection. */
    agentTargetKey?: string | null;
}>): HomeTeamCredentialModelCatalog {
    const serverId = input.serverId?.trim() ?? '';
    const directory = useTeamsDirectory({ enabled: input.enabled && serverId !== '', serverIds: serverId ? [serverId] : [] });
    const scopeServerId = resolveServerProfileScopeIdForIdentifier(serverId);
    const scope = directory.scopes.find((candidate) => candidate.serverId === scopeServerId) ?? null;
    // Team loaders accept canonical Home addresses, not device-local route aliases.
    const rows = React.useMemo(() => directory.rows.map((row) => ({ ...row,
        address: { ...row.address, serverId: resolveServerProfileScopeIdForIdentifier(row.address.serverId) },
    })), [directory.rows]);
    const rowsKey = JSON.stringify(rows.map((row) => [row.address.serverId, row.address.teamId]));
    const applications = React.useMemo<readonly (ProviderBrokerApplicationBindingV1 | undefined)[]>(() => {
        if (!input.agentTargetKey) return [undefined];
        const requirements = readAccountAgentProviderRequirements(input.agentTargetKey);
        return [undefined, ...(requirements ? projectAgentProviderBrokerApplications({
            providers: ADMITTED_PROVIDERS, agentTargetKey: input.agentTargetKey,
            acceptedProtocols: requirements.acceptsProtocols,
        }) : [])];
    }, [input.agentTargetKey]);
    const demands = React.useMemo(() => rows.flatMap(row => applications.map(application => ({ row, application }))), [rows, applications]);
    const demandsKey = JSON.stringify([rowsKey, applications]);

    React.useEffect(() => {
        if (!input.enabled || !scope) return;
        const releases = demands.map(({ row, application }) => observeTeamCredentialResourceCatalog(scope, row.address, application));
        return () => { for (const release of releases) release(); };
        // demandsKey includes every Team address and exact admitted application.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [input.enabled, demandsKey, scope?.accountId, scope?.serverId]);

    const reload = React.useCallback(async () => {
        if (!input.enabled) return;
        directory.refresh();
        if (!scope) return;
        await Promise.all(demands.map(({ row, application }) => refreshTeamCredentialResourceCatalog(scope, row.address, application)));
    }, [directory.refresh, demands, input.enabled, scope]);

    const snapshotVersion = React.useSyncExternalStore(
        subscribeTeamsSnapshots,
        () => JSON.stringify(demands.map(({ row, application }) => {
            const snapshot = getTeamCredentialResourceCatalogSnapshot(scope, row.address, application);
            return [row.address.teamId, snapshot?.status ?? 'none', snapshot?.lastObservedAt ?? null, snapshot?.stale === true, snapshot?.error?.kind ?? null];
        })),
        () => '',
    );

    return React.useMemo(() => {
        const unavailable = directory.unavailableHomes.find((home) => home.serverId === serverId);
        let condition: HomeTeamCredentialModelCatalog['condition'] = unavailable
            ? { reason: unavailable.reason, retryable: unavailable.retryable }
            : null;
        if (!input.enabled || !scope) {
            return {
                resources: EMPTY_RESOURCES,
                teamNameById: {},
                homeNameByTeamId: {},
                currentResourceKeys: new Set(),
                current: false,
                condition: input.enabled ? condition : null,
                reload,
            };
        }
        const resourcesByKey = new Map<string, TeamCredentialResourceCatalogEntryV1>();
        const teamNameById: Record<string, string> = {};
        const homeNameByTeamId: Record<string, string> = {};
        const currentResourceKeys = new Set<string>();
        const nonCurrentModelResourceKeys = new Set<string>();
        let current = directory.kind !== 'loading' && !directory.partial;
        if (directory.kind === 'loading' && !condition) condition = { reason: 'loading', retryable: false };
        for (const { row, application } of demands) {
            teamNameById[row.address.teamId] = row.team.name;
            homeNameByTeamId[row.address.teamId] = row.homeName;
            const snapshot = getTeamCredentialResourceCatalogSnapshot(scope, row.address, application);
            if (snapshot?.status !== 'ready' || snapshot.stale) {
                current = false;
            }
            if (snapshot?.error && (!condition || condition.reason === 'loading')) condition = teamsUnavailableReason(snapshot.error);
            else if (snapshot?.status !== 'ready' && !condition) condition = { reason: 'loading', retryable: false };
            for (const resource of snapshot?.data ?? []) {
                const key = `${resource.teamId}:${resource.id}`;
                if (resource.providerModels.length > 0 && (snapshot?.status !== 'ready' || snapshot.stale)) {
                    nonCurrentModelResourceKeys.add(key);
                }
                const previous = resourcesByKey.get(key);
                if (!previous) {
                    resourcesByKey.set(key, resource);
                    continue;
                }
                // The selection contract does not carry an application. Keep the
                // first declared application for each exact selectable model.
                const modelKeys = new Set<string>();
                const providerModels = [...previous.providerModels, ...resource.providerModels].filter(model => {
                    const selection = model.selection;
                    const modelKey = JSON.stringify([selection.teamId, selection.resourceId, selection.expectedResourceRevision,
                        selection.agentTargetKey, selection.modelId, selection.deliveryMode]);
                    if (modelKeys.has(modelKey)) return false;
                    modelKeys.add(modelKey);
                    return true;
                });
                resourcesByKey.set(key, {
                    ...(previous.providerModels.length > 0 || resource.providerModels.length === 0 ? previous : resource),
                    connectedServiceSelections: previous.connectedServiceSelections.length > 0
                        ? previous.connectedServiceSelections : resource.connectedServiceSelections,
                    providerModels,
                });
            }
            if (snapshot?.status === 'ready' && !snapshot.stale) {
                for (const resource of snapshot.data ?? []) currentResourceKeys.add(`${resource.teamId}:${resource.id}`);
            }
        }
        for (const key of nonCurrentModelResourceKeys) currentResourceKeys.delete(key);
        const resources = [...resourcesByKey.values()];
        return Object.freeze({
            resources: resources.length > 0 ? Object.freeze(resources) : EMPTY_RESOURCES,
            teamNameById: Object.freeze(teamNameById),
            homeNameByTeamId: Object.freeze(homeNameByTeamId),
            currentResourceKeys,
            current,
            condition: current ? null : condition,
            reload,
        });
        // snapshotVersion is the scoped store change signal.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [directory.kind, directory.partial, directory.unavailableHomes, input.enabled, reload, demandsKey, scope?.accountId, scope?.serverId, serverId, snapshotVersion]);
}
