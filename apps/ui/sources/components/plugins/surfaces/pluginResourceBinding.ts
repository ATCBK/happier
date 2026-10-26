import type { PluginResourceContextV1 } from '@happier-dev/protocol';
import type { PluginUiProjectionModel, PluginUiResourceProjection } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY, readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { readPluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginContextualResourceBinding } from './PluginContextualResourceStoreProvider';

export type PluginResourceBindingAdmission = Readonly<{
    projection: PluginUiProjectionModel | null;
    machineId: string | null;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime;
    requireReadAuthority?: boolean;
    isCurrent(): boolean;
}>;

/** One declaration/occurrence owner for host contextual Resource consumers. */
export function resolvePluginContextualResourceBinding(input: PluginResourceBindingAdmission,
    declaration: PluginUiResourceProjection, context: PluginResourceContextV1): PluginContextualResourceBinding | null {
    if (!input.accountLifetime.isCurrent() || !input.isCurrent()) return null;
    const plugin = input.projection?.installedPackagesById[declaration.pluginId];
    if (!declaration.scope || declaration.scope !== context.kind || !plugin?.enabled
        || typeof plugin.occurrenceId !== 'string' || !plugin.occurrenceId
        || declaration.occurrenceId !== undefined && declaration.occurrenceId !== plugin.occurrenceId) return null;
    const origin = readPluginUiContributionOrigin(declaration);
    if (Object.hasOwn(declaration, PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY) && !origin) return null;
    if (input.requireReadAuthority && origin && (origin.phase !== 'current' || !origin.interactionEnabled)) return null;
    const serverId = input.serverId ?? origin?.serverId ?? null;
    if (serverId !== input.accountLifetime.scope.serverId) return null;
    if (declaration.execution?.target === 'account') {
        const accountOrigin = readPluginUiAccountExecutableOrigin(declaration);
        if (!accountOrigin || accountOrigin.serverId !== serverId
            || accountOrigin.accountId !== input.accountLifetime.scope.accountId) return null;
        return { pluginId: declaration.pluginId, machineId: null, serverId, accountLifetime: input.accountLifetime,
            expectedCallerOccurrenceId: accountOrigin.custodyId, context, accountResource: declaration };
    }
    const packageOrigin = readPluginUiContributionOrigin(plugin);
    const machineId = input.machineId ?? origin?.machineId;
    if (!machineId || origin && (origin.machineId !== machineId || origin.serverId !== serverId)
        || packageOrigin && (packageOrigin.machineId !== machineId || packageOrigin.serverId !== serverId)) return null;
    return { pluginId: declaration.pluginId, machineId, serverId, accountLifetime: input.accountLifetime,
        expectedCallerOccurrenceId: plugin.occurrenceId, context };
}
