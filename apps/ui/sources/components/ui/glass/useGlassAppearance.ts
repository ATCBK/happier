import * as React from 'react';

import { useApplySettings } from '@/sync/store/settingsWriters';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';

import {
    readGlassMaterials, readGlassPreset, resolveGlassIntensitySettingsDelta, resolveGlassTintSettingsDelta, type GlassTintStep,
    resolveGlassPresetSettingsDelta,
    type GlassPreset, type GlassSurfaceGroup,
} from './glassMaterial';
import { resolveGlassSurfaceModeSettingsDelta } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';

/** Shared Account owner for Settings, the Appearance popover and Personalize. */
export function useGlassAppearance() {
    const settings = useGlassMaterialSettings();
    const { glassBlurIntensity, glassTintIntensity } = settings;
    const apply = useApplySettings();
    return React.useMemo(() => ({
        settings,
        materials: readGlassMaterials(settings),
        preset: readGlassPreset(settings),
        intensity: glassBlurIntensity ?? 'regular',
        tint: glassTintIntensity ?? 'subtle',
        selectPreset: (preset: GlassPreset) => apply(resolveGlassPresetSettingsDelta(settings, preset)),
        setIntensity: (intensity: 'light' | 'regular' | 'strong') => apply(resolveGlassIntensitySettingsDelta(settings, intensity)),
        setTint: (tint: GlassTintStep) => apply(resolveGlassTintSettingsDelta(settings, tint)),
        setSurfaceMode: (group: GlassSurfaceGroup, mode: 'glass' | 'solid') => apply(resolveGlassSurfaceModeSettingsDelta(settings, group, mode)),
    }), [apply, settings, glassBlurIntensity, glassTintIntensity]);
}
