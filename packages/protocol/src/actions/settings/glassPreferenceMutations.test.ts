import { describe, expect, it } from 'vitest';
import { ACCOUNT_SETTING_DEFINITIONS, accountSettingsParse } from '../../account/settings/accountSettings.js';
import { readPortableAccountSettingBindingV1 } from './accountSettingBindings.js';
import { readBuiltInSettingDeclarationV1, readBuiltInAccountSettingValueV1, parseBuiltInAccountSettingValueV1, buildBuiltInAccountSettingMutationV1 } from './settingsDeclarations.js';
import { glassPresetMaterials, readGlassMaterials, readGlassPreset, readGlassTintedMaterials, resolveGlassIntensitySettingsDelta, resolveGlassPresetSettingsDelta, resolveGlassSurfaceSettingsDelta, resolveGlassSurfaceModeSettingsDelta, resolveGlassTintSettingsDelta } from './glassPreferenceMutations.js';

describe('glass material preferences', () => {
    it('gives backed Elements the composer frost in Auto and Everywhere at any intensity, and a clearer coat in Clear', () => {
        expect(glassPresetMaterials('auto', 'light').card).toEqual({ blur: 'strong', opacity: 0.25 });
        expect(glassPresetMaterials('everywhere', 'regular').card).toEqual({ blur: 'strong', opacity: 0.25 });
        expect(glassPresetMaterials('clear', 'strong').card).toEqual({ blur: 'strong', opacity: 0.15 });
        expect(glassPresetMaterials('solid').card).toEqual({ blur: 'off', opacity: 1 });
    });

    it('keeps the selected preset when only Elements changes, and changes no other group', () => {
        const settings = { glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('auto') };
        const delta = resolveGlassSurfaceModeSettingsDelta(settings, 'card', 'solid');
        expect(readGlassPreset({ ...settings, ...delta })).toBe('auto');
        for (const group of ['chrome', 'sidebar', 'content', 'floating'] as const) {
            expect(delta.glassSurfaceMaterials[group]).toEqual(settings.glassSurfaceMaterials[group]);
        }
        expect(readGlassPreset({ ...settings, ...resolveGlassSurfaceSettingsDelta(settings, 'sidebar', { blur: 'off', opacity: 1 }) })).toBe('custom');
    });

    it('preserves solid Elements through preset and intensity switches, updating glass Elements to the preset coat', () => {
        const settings = { glassBlurEnabled: true, glassSurfaceMaterials: { ...glassPresetMaterials('auto'), card: { blur: 'off' as const, opacity: 1 } } };
        for (const preset of ['solid', 'auto', 'everywhere', 'clear'] as const) {
            const changed = { ...settings, ...resolveGlassPresetSettingsDelta(settings, preset) };
            expect(readGlassMaterials(changed).card).toEqual({ blur: 'off', opacity: 1 });
            expect(readGlassPreset(changed)).toBe(preset);
        }
        expect(readGlassMaterials({ ...settings, ...resolveGlassIntensitySettingsDelta(settings, 'strong') }).card).toEqual({ blur: 'off', opacity: 1 });
        const glass = { glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('auto') };
        expect(readGlassMaterials({ ...glass, ...resolveGlassPresetSettingsDelta(glass, 'clear') }).card).toEqual({ blur: 'strong', opacity: 0.15 });
        const solidPreset = { ...glass, ...resolveGlassPresetSettingsDelta(glass, 'solid') };
        expect(readGlassMaterials({ ...solidPreset, ...resolveGlassPresetSettingsDelta(solidPreset, 'auto') }).card).toEqual({ blur: 'strong', opacity: 0.25 });
        const clear = { ...glass, ...resolveGlassPresetSettingsDelta(glass, 'clear') };
        const authoredClear = { ...clear, ...resolveGlassSurfaceSettingsDelta(clear, 'card', { opacity: 0.33 }) };
        const restoredClear = { ...authoredClear, ...resolveGlassSurfaceModeSettingsDelta(authoredClear, 'card', 'glass') };
        expect(readGlassPreset(restoredClear)).toBe('clear');
        expect(readGlassMaterials(restoredClear).card).toEqual({ blur: 'strong', opacity: 0.15 });
    });

    it('defaults the glass tint to Subtle and scales only named Elements and floating coats by it', () => {
        const parsed = accountSettingsParse({});
        expect(parsed.glassTintIntensity).toBe('subtle');
        expect(ACCOUNT_SETTING_DEFINITIONS.glassTintIntensity).toBeDefined();
        const auto = { glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('auto') };
        const coats = (tint: 'subtle' | 'medium' | 'strong', settings: Parameters<typeof readGlassTintedMaterials>[0] = auto) =>
            readGlassTintedMaterials({ ...settings, ...resolveGlassTintSettingsDelta(settings, tint) });
        // Subtle is the thinnest coat that still carries the warm paint; Medium the earlier faint coat; Strong a frosted one.
        expect(coats('subtle').card.opacity).toBeLessThan(coats('medium').card.opacity);
        expect(coats('subtle').card.opacity).toBeLessThanOrEqual(0.1);
        expect(coats('subtle').floating.opacity).toBeLessThanOrEqual(0.12);
        expect(coats('medium').card.opacity).toBe(0.25);
        expect(coats('strong').card.opacity).toBeGreaterThan(coats('medium').card.opacity);
        expect(coats('strong').floating.opacity).toBeGreaterThan(coats('medium').floating.opacity);
        // The shell planes and the stored preset table do not move with the tint.
        for (const tint of ['subtle', 'medium', 'strong'] as const) {
            const changed = { ...auto, ...resolveGlassTintSettingsDelta(auto, tint) };
            expect(readGlassPreset(changed)).toBe('auto');
            expect(readGlassMaterials(changed)).toEqual(auto.glassSurfaceMaterials);
            for (const group of ['chrome', 'sidebar', 'content'] as const) expect(coats(tint)[group]).toEqual(auto.glassSurfaceMaterials[group]);
        }
        // Solid Elements, the Solid preset and authored (custom) tables keep their exact values.
        const solidCard = { ...auto, glassSurfaceMaterials: { ...auto.glassSurfaceMaterials, card: { blur: 'off' as const, opacity: 1 } } };
        expect(coats('subtle', solidCard).card).toEqual({ blur: 'off', opacity: 1 });
        const custom = { ...auto, ...resolveGlassSurfaceSettingsDelta(auto, 'card', { opacity: 0.33 }) };
        expect(readGlassPreset(custom)).toBe('custom');
        expect(coats('subtle', custom)).toEqual(custom.glassSurfaceMaterials);
        const masked = { ...custom, ...resolveGlassPresetSettingsDelta(custom, 'solid') };
        expect(readGlassMaterials(masked).card).toEqual({ blur: 'off', opacity: 1 });
        expect(masked.glassSurfaceMaterials.card.opacity).toBe(0.33);
        const restored = { ...masked, ...resolveGlassPresetSettingsDelta(masked, 'auto') };
        expect(readGlassPreset(restored)).toBe('auto');
        expect(coats('subtle', restored).card.opacity).toBe(0.07);
        // Equal numbers can carry different intent: an authored Medium value is not the default Glass toggle.
        const authoredDefault = { ...auto, ...resolveGlassSurfaceSettingsDelta(auto, 'card', { opacity: 0.25 }) };
        expect(coats('subtle', authoredDefault).card.opacity).toBe(0.25);
        expect(readGlassPreset(authoredDefault)).toBe('custom');
        const parsedAuthored = accountSettingsParse(authoredDefault);
        expect(coats('subtle', parsedAuthored).card.opacity).toBe(0.25);
        const toggled = { ...authoredDefault, ...resolveGlassSurfaceModeSettingsDelta(authoredDefault, 'card', 'glass') };
        expect(readGlassPreset(toggled)).toBe('auto');
        expect(coats('subtle', toggled).card.opacity).toBe(0.07);
        expect(coats('strong', { glassBlurEnabled: false, glassSurfaceMaterials: auto.glassSurfaceMaterials }).floating).toEqual({ blur: 'off', opacity: 1 });
    });

    it('sets the tint through the declared portable owner', () => {
        const settings = accountSettingsParse({});
        const declaration = readBuiltInSettingDeclarationV1('appearance.glassTint');
        expect(declaration).not.toBeNull();
        if (!declaration) throw new Error('Tint declaration unavailable');
        expect(readBuiltInAccountSettingValueV1(declaration, settings)).toBe('subtle');
        expect(parseBuiltInAccountSettingValueV1(declaration, 'loud').success).toBe(false);
        const parsed = parseBuiltInAccountSettingValueV1(declaration, 'strong');
        expect(parsed.success).toBe(true);
        const binding = readPortableAccountSettingBindingV1({ storage: { owner: 'glassTintStorageBinding' } });
        expect(binding && 'mutate' in binding ? binding.mutate(settings, 'medium') : null).toEqual({ glassTintIntensity: 'medium' });
    });

    it('reads a retained four-group table using its preset card coat without dropping its other choices', () => {
        const { card: _card, ...stored } = glassPresetMaterials('clear', 'strong');
        const settings = accountSettingsParse({ glassBlurEnabled: true, glassBlurIntensity: 'strong', glassSurfaceMaterials: stored });
        expect(readGlassMaterials(settings)).toEqual({ ...stored, card: { blur: 'strong', opacity: 0.15 } });
        expect(readGlassPreset(settings)).toBe('clear');
    });

    it('edits the declared Elements row through the portable owner while retaining the preset', () => {
        const settings = accountSettingsParse({});
        const declaration = readBuiltInSettingDeclarationV1('appearance.glassElements');
        expect(declaration).not.toBeNull();
        if (!declaration) throw new Error('Elements declaration unavailable');
        expect(readBuiltInAccountSettingValueV1(declaration, settings)).toBe('glass');
        expect(parseBuiltInAccountSettingValueV1(declaration, 'solid')).toEqual({ success: true, value: 'solid' });
        const delta = buildBuiltInAccountSettingMutationV1(declaration, settings, 'solid');
        expect(readGlassMaterials({ ...settings, ...delta }).card).toEqual({ blur: 'off', opacity: 1 });
        expect(readGlassPreset({ ...settings, ...delta })).toBe('auto');
        expect(parseBuiltInAccountSettingValueV1(declaration, 'clear').success).toBe(false);
    });

    it('retains the configured Elements choice while Solid masks it and the predecessor switch re-enables Auto', () => {
        const binding = readPortableAccountSettingBindingV1({ storage: { owner: 'glassSurfaceStorageBinding', options: ['card', 'mode'] } });
        const settings = accountSettingsParse(resolveGlassPresetSettingsDelta({}, 'solid'));
        expect(binding?.read(settings)).toBe('glass');
        expect(readGlassMaterials(settings).card).toEqual({ blur: 'off', opacity: 1 });
        expect(readGlassPreset({ ...settings, glassBlurEnabled: true })).toBe('auto');
        const changed = { ...settings, ...binding?.mutate(settings, 'solid') };
        expect(changed.glassBlurEnabled).toBe(false);
        expect(binding?.read(changed)).toBe('solid');
        expect(readGlassPreset(changed)).toBe('solid');
        for (const group of ['chrome', 'sidebar', 'content', 'floating'] as const) {
            expect(changed.glassSurfaceMaterials?.[group]).toEqual(settings.glassSurfaceMaterials?.[group]);
        }
        const chrome = readPortableAccountSettingBindingV1({ storage: { owner: 'glassSurfaceStorageBinding', options: ['chrome', 'mode'] } });
        const changedChrome = { ...settings, ...chrome?.mutate(settings, 'glass') };
        expect(binding?.read(changedChrome)).toBe('glass');
    });

    it('keeps complete custom materials stable and admits retained tables only at the stored boundary', () => {
        const materials = { ...glassPresetMaterials('everywhere'), content: { blur: 'off' as const, opacity: 0.2 } };
        expect(readGlassMaterials({ glassSurfaceMaterials: materials })).toBe(materials);
        const { card: _card, ...retained } = materials;
        expect(ACCOUNT_SETTING_DEFINITIONS.glassSurfaceMaterials.parseStoredValue(retained).success).toBe(true);
        expect(ACCOUNT_SETTING_DEFINITIONS.glassSurfaceMaterials.parseMutationValue(retained).success).toBe(false);
        expect(ACCOUNT_SETTING_DEFINITIONS.glassSurfaceMaterials.parseMutationValue(materials).success).toBe(true);
    });
});
