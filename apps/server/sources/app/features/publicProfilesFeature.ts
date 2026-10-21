import type { FeaturesPayloadDelta } from './types';
import { readPublicProfilesFeatureEnv } from './catalog/readFeatureEnv';

/** Availability is Home-configurable; publication remains explicit and Account-owned. */
export function resolvePublicProfilesFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    return { features: { account: { publicProfiles: { enabled: readPublicProfilesFeatureEnv(env).enabled } } } };
}
