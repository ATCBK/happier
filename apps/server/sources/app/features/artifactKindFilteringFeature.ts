import type { FeaturesPayloadDelta } from './types';

/** Older Homes omit this bit; current clients then retain their full inventory scan. */
export function resolveArtifactKindFilteringFeature(): FeaturesPayloadDelta {
    return { features: { artifacts: { kindFiltering: { enabled: true } } } };
}
