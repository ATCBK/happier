import type { PluginUiInputTypeProjection } from './projection';
import { readPluginUiContributionOrigin } from './projectionOrigins';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** Forms and configuration admission read choices from the same admitted type producer. */
export function readInputTypeOptionsProducer(
    type: PluginUiInputTypeProjection | undefined, serverId: string | null | undefined, singleMachineId?: string | null,
) {
    const origin = readPluginUiContributionOrigin(type);
    if (type && origin?.phase === 'current' && origin.interactionEnabled && origin.serverId && serverId
        && areServerProfileIdentifiersEquivalent(origin.serverId, serverId)) {
        return { machineId: origin.machineId, occurrenceId: type.occurrenceId, executionOrigin: origin.executionOrigin };
    }
    if (type && !origin && singleMachineId) return { machineId: singleMachineId, occurrenceId: type.occurrenceId };
    return { unavailableReasonCode: 'input_type_options_unavailable' as const };
}
