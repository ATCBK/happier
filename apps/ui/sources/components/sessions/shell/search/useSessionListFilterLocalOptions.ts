import * as React from 'react';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/resolveBundledAgentIdFromContributionIdentity';
import { useSessionListRowsByServerId, useSessionOrganizationProjections } from '@/sync/domains/state/storage';
import { projectSessionOrganizationSections } from '@/sync/domains/session/organization/sections';
import { readSessionSectionChoiceLabels } from '@/sync/domains/session/organization/useSessionSectionChoiceLabels';
import { t } from '@/text';

import { qualifySessionListFilterOptionLabel } from './sessionListFilterTagOptions';
import type { SessionListFilterAgentOption, SessionListFilterHomeOption, SessionListFilterSectionOption } from './sessionListFilterEditorModel';
import type { SessionOrganizationProjection } from '@/sync/domains/session/organization/types';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

// Select the primitive fact set at the existing row owner. Unrelated row changes
// then retain the selected array through its shallow selector, without rebuilding labels/options.
function selectAgentTargets(rowsByHome: Readonly<Record<string, Readonly<Record<string, SessionListRenderableSession>>>>): readonly string[] {
    const keys = new Set<string>();
    for (const rows of Object.values(rowsByHome)) for (const row of Object.values(rows)) {
        if (row.agentTargetKey) keys.add(row.agentTargetKey);
    }
    return [...keys].sort();
}

/** Selected tokens keep their word after the value picker releases its detailed row subscription. */
export function readSessionListFilterAgentLabel(key: string): string {
    try {
        const target = parseBackendTargetKeyV2(key);
        if (target.kind === 'backend') return resolveAgentCatalogTitle(target.backendId);
        return target.definitionId ?? resolveAgentCatalogTitle(
            resolveBundledAgentIdFromContributionIdentity(target.identity) ?? buildQualifiedPluginContributionKey(target.identity));
    } catch { return key; } // An unavailable retained selection remains visible, never reinterpreted.
}

export function buildSessionListFilterSectionOptions(homes: readonly SessionListFilterHomeOption[],
    organization: Readonly<Record<string, SessionOrganizationProjection>>): SessionListFilterSectionOption[] {
    return homes.flatMap(home => {
        const projection = organization[home.serverId];
        if (!projection) return [];
        const sections = projectSessionOrganizationSections(home.serverId, projection);
        const labels = readSessionSectionChoiceLabels(sections, home.serverId, t('common.unavailable'));
        return sections.map(section => ({ ...section.address,
            label: qualifySessionListFilterOptionLabel({ label: labels.get(section.address.sectionId) ?? t('common.unavailable'),
                serverId: home.serverId, homeOptions: homes }),
            disabled: section.display.status !== 'available',
        }));
    });
}

/** Open-editor choices from admitted rows and organization facts only; never acquires a catalog or Session body. */
export function useSessionListFilterLocalOptions(homes: readonly SessionListFilterHomeOption[], openedFieldId: string | null,
    hasSelectedSections: boolean): Readonly<{
    agents: readonly SessionListFilterAgentOption[];
    sections: readonly SessionListFilterSectionOption[];
}> {
    const rowServerIds = React.useMemo(() => openedFieldId === 'agents' ? homes.map(home => home.serverId) : [], [homes, openedFieldId]);
    const sectionServerIds = React.useMemo(() => openedFieldId === 'sections' || hasSelectedSections ? homes.map(home => home.serverId) : [], [homes, openedFieldId, hasSelectedSections]);
    const agentKeys = useSessionListRowsByServerId(rowServerIds, selectAgentTargets);
    const organization = useSessionOrganizationProjections(sectionServerIds);
    return React.useMemo(() => {
        const agents = agentKeys.map(key => ({ agentTargetKey: key, label: readSessionListFilterAgentLabel(key) }));
        // A visible picked condition still needs its current name after its picker closes.
        const sections = openedFieldId === 'sections' || hasSelectedSections ? buildSessionListFilterSectionOptions(homes, organization) : [];
        return { agents: agents.sort((left, right) => left.label.localeCompare(right.label)), sections };
    }, [agentKeys, homes, openedFieldId, hasSelectedSections, organization]);
}
