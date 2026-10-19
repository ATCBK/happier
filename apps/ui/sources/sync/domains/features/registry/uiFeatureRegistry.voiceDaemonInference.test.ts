import { describe, expect, it } from 'vitest';

import { buildUiFeatureToggleDefaults } from './uiFeatureToggles';
import { getUiFeatureDefinition } from './uiFeatureRegistry';

describe('uiFeatureRegistry voice daemon inference', () => {
    it.each(['voice.agent', 'voice.daemonInference'] as const)('registers %s as a standard enabled settings toggle', (featureId) => {
        const daemonInference = getUiFeatureDefinition(featureId);

        expect(daemonInference.settingsToggle?.showInSettings).toBe(true);
        expect(daemonInference.settingsToggle?.isExperimental).toBe(false);
        expect(daemonInference.settingsToggle?.defaultEnabled).toBe(true);
    });

    it('excludes graduated Voice preferences from the experimental settings snapshot', () => {
        const defaults = buildUiFeatureToggleDefaults({ experimentalOnly: true });
        expect(defaults).not.toHaveProperty('voice.agent');
        expect(defaults).not.toHaveProperty('voice.daemonInference');
    });
});
