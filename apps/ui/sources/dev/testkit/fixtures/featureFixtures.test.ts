import { describe, expect, it } from 'vitest';

import { createRootLayoutFeaturesResponse } from './featureFixtures';

describe('root layout feature fixtures', () => {
    it('retains the canonical nested gates when overriding Provider and Team enablement', () => {
        const defaults = createRootLayoutFeaturesResponse();
        const response = createRootLayoutFeaturesResponse({
            features: { providers: { enabled: true }, teams: { enabled: true } },
        });

        expect(response.features.providers).toEqual({ ...defaults.features.providers, enabled: true });
        expect(response.features.teams).toEqual({ ...defaults.features.teams, enabled: true });
    });
});
