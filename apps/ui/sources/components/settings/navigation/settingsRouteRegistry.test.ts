import { describe, expect, it } from 'vitest';

import { getSettingsStackScreenDefinitions } from './settingsRouteRegistry';

describe('settingsRouteRegistry', () => {
    it('registers the actions detail route chrome', () => {
        const definitions = getSettingsStackScreenDefinitions((key) => key);
        const routeNames = definitions.map((definition) => definition.name);

        expect(routeNames).toContain('actions/[actionId]');
    });

    it('gives native login import the shared settings header and back navigation', () => {
        const definition = getSettingsStackScreenDefinitions((key) => key)
            .find((entry) => entry.name === 'connected-services/import');

        expect(definition?.options).toMatchObject({
            headerTitle: 'connectedServices.importAccounts.title',
            headerBackTitle: 'common.back',
            headerShown: true,
        });
    });
});
