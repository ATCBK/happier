import type { FeaturesPayloadDelta } from './types';

/** Current Homes own exact accepted-start witness custody; older Homes omit this bit. */
export function resolveSessionAutonomousExchangeFeature(): FeaturesPayloadDelta {
    return { features: { sessions: { enabled: true, autonomousExchange: { enabled: true } } } };
}
