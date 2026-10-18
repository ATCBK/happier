import { describe, expect, it } from 'vitest';

import { getSettingsStackScreenDefinitions } from './settingsRouteRegistry';

describe('settingsRouteRegistry', () => {
    it('gives the reachable connected account import screen its localized title and back affordance', () => {
        const definitions = getSettingsStackScreenDefinitions((key) => key);
        expect(definitions.find((definition) => definition.name === 'connected-services/import')?.options)
            .toMatchObject({
                headerShown: true,
                headerTitle: 'connectedServices.importAccounts.title',
                headerBackTitle: 'common.back',
            });
    });

    it('registers the actions detail route chrome', () => {
        const definitions = getSettingsStackScreenDefinitions((key) => key);
        const routeNames = definitions.map((definition) => definition.name);

        expect(routeNames).toContain('actions/[actionId]');
    });
});
