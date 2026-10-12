import Color from 'color';
import { parseThemeColor } from '@/theme/parseThemeColor';
export { readThemeDocumentColor as readGlassDocumentColor } from '@/theme/parseThemeColor';
import { readGlassMaterials, readGlassPreset, readGlassTintedMaterials } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
import type { GlassMaterialSettings, GlassSurfaceGroup, GlassSurfaceMaterial } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
export { GLASS_PRESETS, GLASS_SURFACE_GROUPS, GLASS_BLUR_STEPS, GLASS_BLUR_INTENSITY, GLASS_BLUR_RADIUS_PX, glassPresetMaterials, readGlassMaterials, readGlassPreset, readGlassTintedMaterials, resolveGlassPresetSettingsDelta, resolveGlassSurfaceSettingsDelta, resolveGlassIntensitySettingsDelta, resolveGlassTintSettingsDelta, GLASS_TINT_STEPS } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';
export type { GlassBlurStep, GlassTintStep, GlassSurfaceGroup, GlassSurfaceMaterial, GlassSurfaceMaterials, GlassPreset, GlassMaterialChoice, GlassMaterialSettings } from '@happier-dev/protocol/actions/settings/glassPreferenceMutations';

export type GlassMaterialEnvironment = Readonly<{
    desktopWindow?: boolean;
    nativeWindowMaterialLive?: boolean;
    reduceTransparency?: boolean;
    highContrast?: boolean;
    windowActive?: boolean;
    atmosphereBehind?: 'none' | 'band' | 'wallpaper';
    /**
     * Native renderers have no web backdrop tone, and in-flow Elements there are a coat without blur:
     * they keep the stored (Medium) coats instead of the tint's, so a Subtle hair never leaves a card bare.
     */
    nativeRenderer?: boolean;
}>;

export type GlassSurfaceResolution = Readonly<{
    material: GlassSurfaceMaterial;
    reason: 'reduceTransparency' | 'inactiveWindow' | 'noBacking' | 'unsupported' | 'unavailable' | null;
}>;

/** Stored choices survive accessibility and window-focus overrides. Never fade foreground content. */
export function resolveGlassSurfaceMaterial(settings: GlassMaterialSettings, group: GlassSurfaceGroup, environment: GlassMaterialEnvironment = {}): GlassSurfaceResolution {
    const requested = (environment.nativeRenderer === true ? readGlassMaterials(settings) : readGlassTintedMaterials(settings))[group];
    const reason: GlassSurfaceResolution['reason'] = environment.reduceTransparency ? 'reduceTransparency'
        : environment.windowActive === false ? 'inactiveWindow'
        : group === 'card' && environment.atmosphereBehind !== 'band' && environment.atmosphereBehind !== 'wallpaper'
            && resolveGlassSurfaceMaterial(settings, 'content', environment).material.opacity === 1 ? 'noBacking'
        : environment.desktopWindow !== true && ((group === 'content' && environment.atmosphereBehind !== 'band' && environment.atmosphereBehind !== 'wallpaper')
            || (group !== 'floating' && group !== 'card' && readGlassPreset(settings) === 'auto')) ? 'unsupported'
        : environment.desktopWindow === true && group !== 'floating' && group !== 'card' && environment.nativeWindowMaterialLive !== true ? 'unavailable'
        : null;
    return {
        material: reason ? { blur: 'off' as const, opacity: 1 } : requested,
        reason,
    };
}

/**
 * How much of the backdrop shows through a named-preset glass surface (k in out = k·X + c), per tint.
 * Over the plain page the glass lands on its own paint (the fixed point). Dark floating glass over an
 * ordinary page passes the page through (k = 1), as monocode's blur does. Over a picture
 * (`atmosphereBehind`), k drops only as far as primary ink needs 4.5:1 over the balloons' bright sky;
 * Strong also compresses ordinary pages for a frosted look. Light hangs its band from white.
 */
export const GLASS_BACKDROP_COMPRESSION = {
    subtle: { plain: { card: { dark: 1, light: 0.43 }, floating: { dark: 1, light: 0.43 } },
        picture: { card: { dark: 0.6, light: 0.43 }, floating: { dark: 0.55, light: 0.43 } } },
    medium: { plain: { card: { dark: 1, light: 0.43 }, floating: { dark: 1, light: 0.43 } },
        picture: { card: { dark: 0.45, light: 0.43 }, floating: { dark: 0.45, light: 0.43 } } },
    strong: { plain: { card: { dark: 0.7, light: 0.3 }, floating: { dark: 0.7, light: 0.3 } },
        picture: { card: { dark: 0.35, light: 0.3 }, floating: { dark: 0.35, light: 0.3 } } },
} as const;

/** The plain page a surface stands on and the solid paint it shows there. Theme variables are resolved live. */
export type GlassBackdropGround = Readonly<{ page: string; solid: string }>;

/**
 * Glass composites the filtered backdrop and coat C at opacity α. Before filter clipping, brightness
 * and lift form an affine map, followed by saturation. `tone` is that filter; `coat` is C.
 */
export type GlassBackdropMap = Readonly<{ tone: string; coat: string | null; opacity?: number }>;

/**
 * Centred dialogs carry the page at a heavy coat behind their blur, as monocode's modals do (the page
 * colour at 55% in dark at Subtle); menus and popovers keep the tint's hair. Over the plain page a
 * dialog still lands on its floating paint. Medium and Strong scale up from Subtle.
 */
export const GLASS_DIALOG_COATS = { subtle: 0.55, medium: 0.7, strong: 0.85 } as const;

const toneNumber = (value: number) => String(Math.round(value * 1000) / 1000);
const parseRgb = (value: string): readonly [number, number, number] | null => {
    const color = parseThemeColor(value);
    if (color === null || color.alpha() < 1) return null;
    const [r, g, b] = color.rgb().array();
    return [r! / 255, g! / 255, b! / 255];
};

/**
 * Solves against the applied, rounded filter including clipping and saturation. A neutral lift is
 * used only where a feasible coat carries the target. Saturated authored fills can exceed that coat's
 * gamut: raise α just enough to reach every channel, dropping the lift when that permits a thinner
 * feasible coat, rather than clamp the coat.
 * This is colour feasibility for named materials, never a legibility floor on custom opacity.
 */
function solveGlassFixedPoint(compression: number, alpha: number, ground: GlassBackdropGround | null): GlassBackdropMap {
    const page = ground ? parseRgb(ground.page) : null;
    const solid = ground ? parseRgb(ground.solid) ?? page : null;
    const scale = compression / (1 - alpha);
    if (!page || !solid || alpha <= 0) return { tone: `brightness(${toneNumber(scale)}) saturate(1.05)`, coat: null };
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    // CSS saturate(1.05)'s sRGB matrix, expressed using its luminance weights.
    const saturate = (rgb: readonly number[]) => {
        const luminance = 0.213 * rgb[0]! + 0.715 * rgb[1]! + 0.072 * rgb[2]!;
        return rgb.map(value => clamp(luminance + 1.05 * (value - luminance)));
    };
    const saturatedPage = saturate(page);
    const spread = solid.map((value, channel) => value - compression * saturatedPage[channel]!);
    const lift = Math.max(0, (Math.max(...spread) - alpha) / (1 - alpha));
    const filter = (neutralLift: number) => {
        if (neutralLift === 0) return {
            tone: `brightness(${toneNumber(scale)}) saturate(1.05)`,
            backdrop: saturate(page.map(value => clamp(value * Number(toneNumber(scale))))),
        };
        // Evaluate the exact rounded CSS coefficients, clamping at each filter boundary.
        const total = Number(toneNumber(scale + neutralLift));
        const pivot = Number(toneNumber(scale / (scale + neutralLift)));
        return {
            tone: `invert(1) brightness(${pivot}) invert(1) brightness(${total}) saturate(1.05)`,
            backdrop: saturate(page.map(value => clamp((1 - clamp((1 - value) * pivot)) * total))),
        };
    };
    let { tone, backdrop } = filter(lift);
    const coatFor = (opacity: number) => solid.map((value, channel) => (value - (1 - opacity) * backdrop[channel]!) / opacity);
    const feasibleOpacity = (filtered: readonly number[]) => Math.max(alpha, ...solid.map((value, channel) => {
        const behind = filtered[channel]!;
        return value >= behind ? (behind === 1 ? 0 : (value - behind) / (1 - behind))
            : (behind - value) / behind;
    }));
    let opacity = alpha;
    let coat = coatFor(opacity);
    if (coat.some(value => value < 0 || value > 1)) {
        opacity = feasibleOpacity(backdrop);
        const unlifted = filter(0);
        const unliftedOpacity = feasibleOpacity(unlifted.backdrop);
        // Keep the lift when rounding only needs a slight α adjustment; saturated targets can use
        // a much thinner feasible coat without it. Both candidates solve the actual clipped filter.
        if (unliftedOpacity < opacity) {
            ({ tone, backdrop } = unlifted);
            opacity = unliftedOpacity;
        }
        coat = coatFor(opacity);
    }
    return { tone, coat: Color.rgb(coat.map(value => value * 255)).round().string(),
        ...(opacity !== alpha ? { opacity } : {}) };
}

/**
 * The one owner of a glass surface's backdrop treatment. Named-preset Elements and floating surfaces
 * use the fixed-point model; picture-backed shell planes keep a dimming tone under their heavy coat.
 * Custom, Solid, Reduce Transparency and unbacked surfaces return null and paint exactly as set.
 */
export function resolveGlassBackdropMap(settings: GlassMaterialSettings, group: GlassSurfaceGroup, dark: boolean, environment: GlassMaterialEnvironment = {}, ground: GlassBackdropGround | null = null, dialog = false): GlassBackdropMap | null {
    const wallpaperPlane = environment.atmosphereBehind === 'wallpaper' && (group === 'chrome' || group === 'sidebar');
    if ((group !== 'floating' && group !== 'card' && !wallpaperPlane) || readGlassPreset(settings) === 'custom') return null;
    const { opacity } = resolveGlassSurfaceMaterial(settings, group, environment).material;
    if (opacity === 1) return null;
    if (group === 'floating' || group === 'card') {
        const picture = environment.atmosphereBehind === 'band' || environment.atmosphereBehind === 'wallpaper';
        const tint = settings.glassTintIntensity ?? 'subtle';
        if (group === 'floating' && dialog) {
            // The heavy coat carries the dialog: the backdrop passes at most at 1 − α, never brightened.
            const alpha = GLASS_DIALOG_COATS[tint];
            const compression = Math.min(1 - alpha, dark ? 1 : GLASS_BACKDROP_COMPRESSION[tint].plain.floating.light);
            return { opacity: alpha, ...solveGlassFixedPoint(compression, alpha, ground) };
        }
        // Every tint lands on the surface's own solid paint over the plain page, its warm hue included;
        // Subtle only carries that paint in a thinner coat, so the picture shows through more.
        return solveGlassFixedPoint(GLASS_BACKDROP_COMPRESSION[tint][picture ? 'picture' : 'plain'][group][dark ? 'dark' : 'light'],
            opacity, ground);
    }
    // Shell planes over a wallpaper carry most of their own paint; the tone only tames highlights.
    return { tone: dark ? 'brightness(0.65) saturate(1.05)'
        : 'invert(1) contrast(0.88) brightness(0.49) invert(1) saturate(1.05)', coat: null };
}

/** The backdrop filter of `resolveGlassBackdropMap`, or '' when the surface keeps its exact paint. */
export function resolveGlassBackdropTone(settings: GlassMaterialSettings, group: GlassSurfaceGroup, dark: boolean, environment: GlassMaterialEnvironment = {}, ground: GlassBackdropGround | null = null, dialog = false): string {
    return resolveGlassBackdropMap(settings, group, dark, environment, ground, dialog)?.tone ?? '';
}
