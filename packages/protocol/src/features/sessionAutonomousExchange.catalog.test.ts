import { describe, expect, it } from 'vitest';

import { FEATURE_CATALOG } from './catalog.js';
import { FeaturesResponseSchema } from './payload/featuresResponseSchema.js';
import { readServerEnabledBit } from './serverEnabledBit.js';

describe('sessions.autonomousExchange contract', () => {
  it('advertises exact accepted-start support only from a server-owned bit', () => {
    expect(FEATURE_CATALOG['sessions.autonomousExchange']).toMatchObject({
      representation: 'server', defaultFailMode: 'fail_closed', dependencies: ['sessions'],
    });
    const olderHome = FeaturesResponseSchema.parse({ features: {}, capabilities: {} });
    expect(readServerEnabledBit(olderHome, 'sessions.autonomousExchange')).toBe(false);
    const currentHome = FeaturesResponseSchema.parse({ features: {
      sessions: { enabled: true, autonomousExchange: { enabled: true } },
    }, capabilities: {} });
    expect(readServerEnabledBit(currentHome, 'sessions.autonomousExchange')).toBe(true);
  });
});
