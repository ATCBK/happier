import type { FeaturesPayloadDelta } from './types';

/** Build policy may disable this feature; clients then retain their full inventory scan. */
export function resolveArtifactKindFilteringFeature(): FeaturesPayloadDelta {
    return { features: { artifacts: { kindFiltering: { enabled: true } } } };
}
