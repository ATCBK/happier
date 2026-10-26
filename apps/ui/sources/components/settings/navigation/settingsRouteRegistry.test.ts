import { describe, expect, it } from 'vitest';

import { getSettingsStackScreenDefinitions, withSettingsRootBackAction } from './settingsRouteRegistry';

describe('settingsRouteRegistry', () => {
    it('gives the prompts navigator ownership of its screen headers', () => {
        const settings = getSettingsStackScreenDefinitions((key) => key);
        expect(settings.find((entry) => entry.name === 'prompts')?.options.headerShown).toBe(false);
        expect(settings.some((entry) => entry.name.startsWith('prompts/'))).toBe(false);

        const prompts = getSettingsStackScreenDefinitions((key) => key, 'prompts');
        expect(prompts.find((entry) => entry.name === 'docs/index')?.options).toMatchObject({
            headerTitle: 'promptLibrary.prompts',
            headerShown: true,
        });
        expect(prompts.find((entry) => entry.name === 'index')?.options.headerTitle).toBe('settings.prompts');
        expect(prompts.some((entry) => entry.name === 'account')).toBe(false);
    });

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

    it('adds a deterministic back action only to the top-level settings screen', () => {
        const settings = getSettingsStackScreenDefinitions((key) => key);
        const backAction = () => {};
        const withBackAction = withSettingsRootBackAction(settings, backAction, 'settings');

        expect(withBackAction.find((entry) => entry.name === 'index')?.options.headerBackAction).toBe(backAction);
        expect(withBackAction.find((entry) => entry.name === 'account')?.options.headerBackAction).toBeUndefined();

        const prompts = getSettingsStackScreenDefinitions((key) => key, 'prompts');
        const promptsWithBackAction = withSettingsRootBackAction(prompts, backAction, 'prompts');
        expect(promptsWithBackAction.find((entry) => entry.name === 'index')?.options.headerBackAction).toBeUndefined();
    });
});
