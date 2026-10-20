import { describe, expect, it } from 'vitest';
import { settingRendersOnHost } from '@/components/settings/catalog/settingDeclarations';
import { APPEARANCE_MOTION_SETTINGS } from './appearanceSettings';
import { resolveAppearanceDefaults } from './appearanceDefaults';

describe('Appearance motion device feedback', () => {
    it('declares the native-only device preference through portable metadata and resets it on', () => {
        const setting = APPEARANCE_MOTION_SETTINGS.settings.haptics;
        expect(setting.storage).toMatchObject({ scope: 'local', key: 'hapticsEnabled', access: 'read_write' });
        expect(settingRendersOnHost(setting, { os: 'ios', desktop: false })).toBe(true);
        expect(settingRendersOnHost(setting, { os: 'android', desktop: false })).toBe(true);
        expect(settingRendersOnHost(setting, { os: 'web', desktop: false })).toBe(false);
        expect(settingRendersOnHost(setting, { os: 'web', desktop: true })).toBe(false);
        expect(resolveAppearanceDefaults().local.hapticsEnabled).toBe(true);
    });
});
