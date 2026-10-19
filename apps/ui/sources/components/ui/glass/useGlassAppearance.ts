import * as React from 'react';

import { useApplySettings } from '@/sync/store/settingsWriters';
import { useGlassMaterialSettings } from './useGlassMaterialSettings';

import {
    readGlassMaterials, readGlassPreset, readGlassTintIntensity, resolveGlassIntensitySettingsDelta, resolveGlassTintSettingsDelta,
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
        tint: readGlassTintIntensity(glassTintIntensity),
        selectPreset: (preset: GlassPreset) => apply(resolveGlassPresetSettingsDelta(settings, preset)),
        setIntensity: (intensity: 'light' | 'regular' | 'strong') => apply(resolveGlassIntensitySettingsDelta(settings, intensity)),
        setTint: (tint: number) => apply(resolveGlassTintSettingsDelta(settings, tint)),
        setSurfaceMode: (group: GlassSurfaceGroup, mode: 'glass' | 'solid') => apply(resolveGlassSurfaceModeSettingsDelta(settings, group, mode)),
    }), [apply, settings, glassBlurIntensity, glassTintIntensity]);
}
