import { projectPluginSettingsContributionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginSettingsContributionV2 } from '@happier-dev/protocol/plugins/contributions/settings';
import { qualifyPluginContributionReferenceV1, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { BUNDLED_CANONICAL_AGENT_DECLARATIONS } from '@/agents/registry/generatedBundledPluginEntries';

import {
    mapV2EditableSettingsGroup,
    type PluginProjectionEditableSettingsGroup,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

/**
 * The one Account-scoped Settings declaration projection that needs no daemon.
 *
 * Account Availability admits the current normalized manifest for an enabled
 * release, and that manifest already carries the plugin's declared Settings
 * contributions. Reuse the Protocol normalizer and the existing UI projection
 * mapper here rather than recreating a Settings parser: two callers need this
 * exact answer — the Settings page's Account recovery route, and the mounted
 * plugin surface's own Account Settings client — and a second derivation is how
 * one of them would start admitting a field the other refuses.
 *
 * A daemon-custodied secret field is dropped. Cold Account access has no
 * selected daemon target, and reinterpreting a daemon secret as an Account
 * SavedSecret would move custody by accident.
 */

export const EMPTY_ACCOUNT_DECLARED_SETTINGS_GROUPS: readonly PluginProjectionEditableSettingsGroup[] = Object.freeze([]);

/** The same no-execute bundled declarations feed Agent preferences and Account Actions. */
export function projectBundledAgentAccountSettingsGroups(params: Readonly<{
    pluginId: string;
    targetAgent?: PluginContributionIdentityV1;
}>): readonly PluginProjectionEditableSettingsGroup[] {
    return Object.values(BUNDLED_CANONICAL_AGENT_DECLARATIONS).flatMap(declaration => {
        if (declaration.identity.pluginId !== params.pluginId
            || params.targetAgent && (declaration.identity.pluginId !== params.targetAgent.pluginId
                || declaration.identity.localId !== params.targetAgent.localId)) return [];
        return projectAccountDeclaredPluginSettingsGroups({
            pluginId: params.pluginId,
            targetAgent: declaration.identity,
            declaration: { id: params.pluginId, contributes: { settings: declaration.accountSettings } },
        });
    });
}

export function projectAccountDeclaredPluginSettingsGroups(params: Readonly<{
    pluginId: string;
    declaration: Readonly<{
        id: string;
        contributes: Readonly<{ settings?: readonly PluginSettingsContributionV2[] }>;
    }> | null | undefined;
    targetAgent?: PluginContributionIdentityV1;
}>): readonly PluginProjectionEditableSettingsGroup[] {
    const declaration = params.declaration;
    if (!declaration || declaration.id !== params.pluginId) return EMPTY_ACCOUNT_DECLARED_SETTINGS_GROUPS;

    const groups: PluginProjectionEditableSettingsGroup[] = [];
    for (const definition of declaration.contributes.settings ?? []) {
        if (definition.scope !== 'account') continue;
        if (params.targetAgent) {
            if (definition.target.kind !== 'agent') continue;
            const target = qualifyPluginContributionReferenceV1(definition.target.agent, params.pluginId);
            if (target.pluginId !== params.targetAgent.pluginId || target.localId !== params.targetAgent.localId) continue;
        } else if (definition.target.kind !== 'plugin') continue;
        try {
            const projected = projectPluginSettingsContributionV2({
                pluginId: params.pluginId,
                definition,
            });
            const group = mapV2EditableSettingsGroup(projected);
            const fields = group.fields.filter((field) => field.secretCustody !== 'daemon');
            if (fields.length > 0) {
                groups.push(Object.freeze({ ...group, fields: Object.freeze(fields) }));
            }
        } catch {
            // The release is syntactically current but semantically unsuitable
            // for editable Settings. Account access fails closed for that
            // declaration rather than guessing at a partial contribution.
        }
    }
    return groups.length > 0 ? Object.freeze(groups) : EMPTY_ACCOUNT_DECLARED_SETTINGS_GROUPS;
}
