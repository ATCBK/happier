import * as React from 'react';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import {
    useProjectedQualifiedConnectedAccountTargetPresentations,
    type ProjectedQualifiedConnectedAccountTarget,
} from '@/hooks/server/connectedServices/useProjectedQualifiedConnectedAccountTargetPresentations';

import type { SessionModelGatewaySlot, SessionModelProjectionGroup } from './buildSessionModelPickerSections';

type SlotTarget = SessionModelGatewaySlot['target'];

function slotTargetKey(target: SlotTarget): string {
    return target.kind === 'group'
        ? `group:${buildQualifiedPluginContributionKey(target.service)}:${target.groupId}`
        : `account:${buildQualifiedPluginContributionKey(target.account.service)}:${target.account.accountId}`;
}

/**
 * "ChatGPT · Codex pool": the service, then the pool or Account it is served through. A name that
 * already says its service ("ChatGPT account") stands alone.
 */
function slotHeading(serviceTitle: string, primaryLabel: string): string {
    return primaryLabel === serviceTitle || primaryLabel.startsWith(serviceTitle)
        ? primaryLabel
        : `${serviceTitle} · ${primaryLabel}`;
}

/**
 * Names a Gateway model's vendor slots for the browsing picker, from the Account's own display facts.
 * Returns null while those facts are still loading, so rows do not regroup under placeholder names.
 */
export function useGatewaySlotTitle(
    groups: readonly Pick<SessionModelProjectionGroup, 'rows'>[],
    serverId: string | null,
): ((slot: SessionModelGatewaySlot) => string | null) | undefined {
    const targets = React.useMemo(() => {
        const byKey = new Map<string, ProjectedQualifiedConnectedAccountTarget>();
        for (const group of groups) {
            for (const row of group.rows) {
                for (const slot of row.gatewaySlots ?? []) {
                    const key = slotTargetKey(slot.target);
                    if (!byKey.has(key)) byKey.set(key, { key, target: slot.target });
                }
            }
        }
        return [...byKey.values()];
    }, [groups]);
    const { presentationsByKey, serviceTitleByKey, loading } = useProjectedQualifiedConnectedAccountTargetPresentations(serverId, targets);
    return React.useMemo(() => {
        if (targets.length === 0 || loading) return undefined;
        return (slot) => {
            const key = slotTargetKey(slot.target);
            const presentation = presentationsByKey[key];
            return presentation ? slotHeading(serviceTitleByKey[key] ?? '', presentation.primaryLabel) : null;
        };
    }, [loading, presentationsByKey, serviceTitleByKey, targets.length]);
}
