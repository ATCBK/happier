import { describe, expect, it } from 'vitest';

describe('provider settings account artifact', () => {
    it('excludes the transferred provider subtree from account and local preference owners', async () => {
        const { ACCOUNT_SETTING_ARTIFACTS, settingsParse } = await import('./settings');
        const { LOCAL_SETTING_ARTIFACTS } = await import('./registry/local/localSettingDefinitions');

        expect(ACCOUNT_SETTING_ARTIFACTS.definitions).not.toHaveProperty('providerSettingsV1');
        expect(ACCOUNT_SETTING_ARTIFACTS.defaults).not.toHaveProperty('providerSettingsV1');
        expect(LOCAL_SETTING_ARTIFACTS.definitions).not.toHaveProperty('providerSettingsV1');

        const future = { v: 2, opaque: { preserve: true } };
        expect(settingsParse({ providerSettingsV1: future })).not.toHaveProperty('providerSettingsV1');
    });
});
