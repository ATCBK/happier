import { DEFAULT_HOME_ATMOSPHERE, type HomeAtmosphere, type ProjectAtmosphere } from '@happier-dev/protocol/account/settings/accountSettings';
import type { GlassMaterialEnvironment } from '@/components/ui/glass/glassMaterial';
import { builtinPictureLocalId, pictureSourceMatches } from './ensureBuiltinPicture';
import type { BuiltinPicture, PictureRecord } from './pictureStore.types';

export type AtmosphereSurface = 'home' | 'new-session' | Readonly<{ project: Readonly<{ serverId: string; projectKey: string }> }>;
export type ResolvedAtmosphere<TPicture extends BuiltinPicture = BuiltinPicture> = HomeAtmosphere & Readonly<{
    pictureRecord: PictureRecord | null;
    builtinPicture: TPicture | null;
    reducedMotion: boolean;
    reduceTransparency: boolean;
    fallbackReason: 'unknown-picture' | 'picture-unavailable' | null;
}>;

/** Projects inherit moment switches from Home; their presentation override is otherwise complete. */
export function selectAtmosphereSettings(surface: AtmosphereSurface, home: HomeAtmosphere,
    projectOverride?: 'home' | ProjectAtmosphere): HomeAtmosphere {
    return typeof surface === 'object' && projectOverride && projectOverride !== 'home'
        ? { ...projectOverride, moments: home.moments } : home;
}

export function atmospherePictureLocalId(settings: HomeAtmosphere): string | null {
    if (settings.source !== 'picture') return null;
    return settings.picture.ref.kind === 'builtin' ? builtinPictureLocalId(settings.picture.ref.id) : settings.picture.ref.localId;
}

/** One decision owner for Home, new session, Projects, device bytes and accessibility. */
export function resolveAtmosphere<TPicture extends BuiltinPicture>(input: Readonly<{
    surface: AtmosphereSurface;
    home: HomeAtmosphere;
    projectOverride?: 'home' | ProjectAtmosphere;
    pictures: readonly TPicture[];
    pictureRecord?: PictureRecord;
    shownPicture?: ResolvedAtmosphere<TPicture> | null;
    readingPicture?: boolean;
    isPhone: boolean;
    glassEnvironment: GlassMaterialEnvironment;
    reduceTransparency: boolean;
    reducedMotion: boolean;
}>): ResolvedAtmosphere<TPicture> {
    let settings = selectAtmosphereSettings(input.surface, input.home, input.projectOverride);
    let fallbackReason: ResolvedAtmosphere['fallbackReason'] = null;
    let builtinPicture: TPicture | null = null;
    let pictureRecord: PictureRecord | null = null;
    if (settings.source === 'picture') {
        const ref = settings.picture.ref;
        builtinPicture = ref.kind === 'builtin' ? input.pictures.find(picture => picture.id === ref.id) ?? null : null;
        if (ref.kind === 'builtin' && !builtinPicture) fallbackReason = 'unknown-picture';
        else if (!input.pictureRecord || input.pictureRecord.localId !== atmospherePictureLocalId(settings)
            || input.pictureRecord.kind !== ref.kind
            || (builtinPicture && !pictureSourceMatches(input.pictureRecord.source, builtinPicture.src))) fallbackReason = 'picture-unavailable';
        else pictureRecord = input.pictureRecord;
        // Retain only the available image's identity/bytes; all settings and environment decisions
        // below are current, including layout, accessibility, phone placement and moments.
        if (fallbackReason === 'picture-unavailable' && input.readingPicture && input.shownPicture?.pictureRecord) {
            settings = { ...settings, picture: { ...settings.picture, ref: input.shownPicture.picture.ref } };
            pictureRecord = input.shownPicture.pictureRecord;
            builtinPicture = input.shownPicture.builtinPicture;
            fallbackReason = null;
        }
        if (fallbackReason) settings = { ...DEFAULT_HOME_ATMOSPHERE, moments: input.home.moments };
    }
    const planet = input.isPhone && settings.planet.placement === 'rise'
        ? { ...settings.planet, placement: 'corner' as const } : settings.planet;
    const reduceTransparency = input.reduceTransparency || input.glassEnvironment.reduceTransparency === true;
    return { ...settings, planet, pictureRecord, builtinPicture,
        reducedMotion: input.reducedMotion, reduceTransparency, fallbackReason };
}
