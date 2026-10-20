import type { ProviderObservationV1, SupportedNativeIntent } from '@happier-dev/protocol/machines/managed/providerFactsV1';

/** Fresh native truth settles power custody, without claiming the old intent succeeded. */
export function doesManagedNativeObservationSettleIntent(intent: SupportedNativeIntent,
    observation: ProviderObservationV1 | undefined, previousObservation?: ProviderObservationV1): boolean {
    if (!observation || intent === 'rebuild'
        || previousObservation && observation.observedAt <= previousObservation.observedAt) return false;
    if (observation.availability === 'absent') return true;
    return intent !== 'delete' && observation.availability === 'present'
        && (observation.power === 'running' || observation.power === 'stopped' || observation.power === 'suspended');
}
