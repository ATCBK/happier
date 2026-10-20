import { expect, it } from 'vitest';

import { resolveSessionAutonomousExchangeFeature } from './sessionAutonomousExchangeFeature';

it('advertises the exact autonomous turn-start contract on current Homes', () => {
    expect(resolveSessionAutonomousExchangeFeature()).toMatchObject({
        features: { sessions: { enabled: true, autonomousExchange: { enabled: true } } },
    });
});
