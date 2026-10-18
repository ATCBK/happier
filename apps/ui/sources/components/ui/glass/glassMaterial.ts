import Color from 'color';
import { parseThemeColor } from '@/theme/parseThemeColor';
import { GLASS_BACKED_FAINT_INK_SHARE } from './glassBackedInk';
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
    /** The measured tone of the picture behind content, published by the atmosphere while it covers an area. */
    atmosphereTone?: GlassAtmosphereTone;
    /**
     * Native renderers have no web backdrop tone, and in-flow Elements there are a coat without blur:
     * they keep the stored (Medium) coats instead of the tint's, so a Subtle hair never leaves a card bare.
     */
    nativeRenderer?: boolean;
}>;

/**
 * Relative luminance (0–1) of the picture where content sits: the near-darkest and near-lightest of the
 * content column (where cards can stand), and the middle around the column's centre (where head lines stand on the
 * picture itself). Default glass and ink derive from it, so they stay legible over pictures that run
 * against the theme.
 */
export type GlassAtmosphereTone = Readonly<{
    dark: number;
    light: number;
    focus: number;
    /**
     * The ink of the Wallpaper plane, where head lines stand on the picture itself: the atmosphere decides it
     * together with the haze under them (`resolveWallpaperHaze`). Absent means the theme's.
     */
    ink?: 'theme' | 'page';
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
export type GlassBackdropGround = Readonly<{ page: string; solid: string; ink?: string }>;

/**
 * Glass composites the filtered backdrop and coat C at opacity α. Before filter clipping, brightness
 * and lift form an affine map, followed by saturation. `tone` is that filter; `coat` is C.
 */
export type GlassBackdropMap = Readonly<{ tone: string; coat: string | null; opacity?: number }>;

/**
 * How a floating surface declares its job. Panels (centred dialogs, phone sheets and large anchored
 * panels such as Add widget, About this widget or Workflow run inputs) carry the page at a heavy coat
 * behind their blur, as monocode's modals do (the page colour at 55% in dark at Subtle); menus,
 * tooltips and small popovers keep the tint's hair (owner, 2026-10-16). Over the plain page a panel
 * still lands on its floating paint. Medium and Strong scale up from Subtle.
 */
export type FloatingSurfaceRole = 'menu' | 'panel';
export const GLASS_PANEL_COATS = { subtle: 0.55, medium: 0.7, strong: 0.85 } as const;

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
 * Body ink keeps 4.5:1 and the faint step 3:1 over default glass (DESIGN.md). The solve below ignores the
 * filter's saturation and rounding, so it aims a few percent above both.
 */
const LEGIBLE_BODY_CONTRAST = 4.5 * 1.03;
const LEGIBLE_FAINT_CONTRAST = 3 * 1.03;
const relativeLuminance = (rgb: readonly number[]) => {
    const linear = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
};
const contrast = (a: readonly number[], b: readonly number[]) => {
    const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
    return (high! + 0.05) / (low! + 0.05);
};
/** The sRGB grey with relative luminance `luminance`. */
const greyOf = (luminance: number) => {
    const linear = Math.min(1, Math.max(0, luminance));
    return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
};

/**
 * The most backdrop a named material lets through over the measured picture. The glass is the surface's
 * solid paint plus `compression` × (picture − page), so where the picture runs against the theme (its darkest
 * under light ink, its lightest under dark ink) the compression drops just far enough for the
 * theme's ink to keep its contrast. Pictures that agree with the theme, and the plain page, change nothing.
 */
function legibleCompression(compression: number, dark: boolean, tone: GlassAtmosphereTone | undefined, ground: GlassBackdropGround | null): number {
    const page = ground ? parseRgb(ground.page) : null;
    const solid = ground ? parseRgb(ground.solid) ?? page : null;
    const ink = ground?.ink ? parseRgb(ground.ink) : null;
    if (!tone || !page || !solid || !ink) return compression;
    const picture = greyOf(dark ? tone.light : tone.dark);
    const holds = (k: number) => {
        const glass = solid.map((value, channel) => Math.min(1, Math.max(0, value + k * (picture - page[channel]!))));
        const faint = ink.map((value, channel) => value * GLASS_BACKED_FAINT_INK_SHARE + glass[channel]! * (1 - GLASS_BACKED_FAINT_INK_SHARE));
        return contrast(ink, glass) >= LEGIBLE_BODY_CONTRAST && contrast(faint, glass) >= LEGIBLE_FAINT_CONTRAST;
    };
    if (holds(compression)) return compression;
    let low = 0;
    let high = compression;
    for (let step = 0; step < 20; step++) {
        const middle = (low + high) / 2;
        if (holds(middle)) low = middle; else high = middle;
    }
    return low;
}

/**
 * The one owner of a glass surface's backdrop treatment. Named-preset Elements and floating surfaces
 * use the fixed-point model; picture-backed shell planes keep a dimming tone under their heavy coat.
 * Custom, Solid, Reduce Transparency and unbacked surfaces return null and paint exactly as set.
 */
export function resolveGlassBackdropMap(settings: GlassMaterialSettings, group: GlassSurfaceGroup, dark: boolean, environment: GlassMaterialEnvironment = {}, ground: GlassBackdropGround | null = null, panel = false): GlassBackdropMap | null {
    const wallpaperPlane = environment.atmosphereBehind === 'wallpaper' && (group === 'chrome' || group === 'sidebar');
    if ((group !== 'floating' && group !== 'card' && !wallpaperPlane) || readGlassPreset(settings) === 'custom') return null;
    const { opacity } = resolveGlassSurfaceMaterial(settings, group, environment).material;
    if (opacity === 1) return null;
    if (group === 'floating' || group === 'card') {
        const picture = environment.atmosphereBehind === 'band' || environment.atmosphereBehind === 'wallpaper';
        const tint = settings.glassTintIntensity ?? 'subtle';
        if (group === 'floating' && panel) {
            // The heavy coat carries the panel: the backdrop passes at most at 1 − α, never brightened.
            const alpha = GLASS_PANEL_COATS[tint];
            const compression = legibleCompression(Math.min(1 - alpha, dark ? 1 : GLASS_BACKDROP_COMPRESSION[tint].plain.floating.light), dark, picture ? environment.atmosphereTone : undefined, ground);
            return { opacity: alpha, ...solveGlassFixedPoint(compression, alpha, ground) };
        }
        // Every tint lands on the surface's own solid paint over the plain page, its warm hue included;
        // Subtle only carries that paint in a thinner coat, so the picture shows through more.
        return solveGlassFixedPoint(legibleCompression(GLASS_BACKDROP_COMPRESSION[tint][picture ? 'picture' : 'plain'][group][dark ? 'dark' : 'light'], dark, picture ? environment.atmosphereTone : undefined, ground),
            opacity, ground);
    }
    // Shell planes over a wallpaper carry most of their own paint; the tone only tames highlights.
    return { tone: dark ? 'brightness(0.65) saturate(1.05)'
        : 'invert(1) contrast(0.88) brightness(0.49) invert(1) saturate(1.05)', coat: null };
}

/** The backdrop filter of `resolveGlassBackdropMap`, or '' when the surface keeps its exact paint. */
export function resolveGlassBackdropTone(settings: GlassMaterialSettings, group: GlassSurfaceGroup, dark: boolean, environment: GlassMaterialEnvironment = {}, ground: GlassBackdropGround | null = null, panel = false): string {
    return resolveGlassBackdropMap(settings, group, dark, environment, ground, panel)?.tone ?? '';
}
