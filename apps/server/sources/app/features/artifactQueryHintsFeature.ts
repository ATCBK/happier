import type { FeaturesPayloadDelta } from './types';

/** Support negotiation for the current Artifact index contract; no legacy Home inference. */
export function resolveArtifactQueryHintsFeature(): FeaturesPayloadDelta {
    return { features: { artifacts: { queryHints: { enabled: true } } } };
}
