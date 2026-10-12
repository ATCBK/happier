import { describe, expect, it } from 'vitest';
import { APPEARANCE_SETTINGS } from './appearanceSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { readGlassMaterials, readGlassPreset } from '@/components/ui/glass/glassMaterial';

describe('Appearance material Actions', () => {
    it('binds presets and exact group values through the material owner', () => {
        const preset = APPEARANCE_SETTINGS.settings.glassPreset?.storage;
        expect(preset).toMatchObject({ scope: 'account', kind: 'owner', access: 'read_write' });
        if (!preset || !('kind' in preset) || preset.scope !== 'account' || preset.kind !== 'owner') throw new Error('Expected Account material owner');
        expect(preset.parse('everywhere')).toEqual({ success: true, value: 'everywhere' });
        expect(preset.parse('clear')).toEqual({ success: true, value: 'clear' });
        expect(readGlassPreset({ ...settingsDefaults, ...preset.mutate(settingsDefaults, 'clear') })).toBe('clear');
        expect(preset.parse('custom')).toEqual({ success: false });
        const everywhere = { ...settingsDefaults, ...preset.mutate(settingsDefaults, 'everywhere') };
        expect(readGlassPreset(everywhere)).toBe('everywhere');
        expect(readGlassMaterials(everywhere).floating).toEqual({ blur: 'strong', opacity: 0.02 });
        const auto = { ...settingsDefaults, ...preset.mutate(settingsDefaults, 'auto') };
        expect(readGlassPreset(auto)).toBe('auto');
        expect(readGlassMaterials(auto).floating).toEqual({ blur: 'strong', opacity: 0.02 });
        const layer = APPEARANCE_SETTINGS.settings.glassWindow?.storage;
        expect(layer).toMatchObject({ scope: 'account', kind: 'owner' });
        if (!layer || !('kind' in layer) || layer.scope !== 'account' || layer.kind !== 'owner') throw new Error('Expected Account material owner');
        expect(layer.parse('solid')).toEqual({ success: true, value: 'solid' });
        expect(layer.parse('auto')).toEqual({ success: false });
        const custom = { ...everywhere, ...layer.mutate(everywhere, 'solid') };
        expect(custom.glassSurfaceMaterials?.content).toEqual({ blur: 'off', opacity: 1 });
        expect(custom.glassSurfaceMaterials?.sidebar).toEqual(everywhere.glassSurfaceMaterials?.sidebar);
        expect(readGlassPreset(custom)).toBe('custom');
    });
});
