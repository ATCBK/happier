import * as React from 'react';
import { useAtmospherePictureCatalog } from './useAtmospherePictureCatalog';
import { useSetting, useProjectAtmosphere } from '@/sync/store/hooks';
import { useGlassRuntimeEnvironment } from '@/components/ui/glass/glassRuntimeEnvironment';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useDeviceType } from '@/utils/platform/responsive';
import { pictureStore } from './pictureStore';
import { useStoredPictureRecord } from './useStoredPictureRecord';
import { atmospherePictureLocalId, resolveAtmosphere, selectAtmosphereSettings, type AtmosphereTarget, type ResolvedAtmosphere } from './resolveAtmosphere';

export { resolveAtmosphere } from './resolveAtmosphere';
export type { AtmosphereSurface, AtmosphereTarget, ResolvedAtmosphere } from './resolveAtmosphere';

/** Device availability never delays content or writes the user's synced selection. */
export function useAtmosphere(surface: AtmosphereTarget) {
    const pictures = useAtmospherePictureCatalog();
    const home = useSetting('homeAtmosphere');
    const projectOverride = useProjectAtmosphere(typeof surface === 'object' && 'project' in surface ? surface.project : undefined);
    const glassEnvironment = useGlassRuntimeEnvironment();
    const reduceTransparency = useReduceTransparency();
    const reducedMotion = useReducedMotionPreference();
    const isPhone = useDeviceType() === 'phone';
    const surfaceKind = typeof surface === 'string' ? surface : 'project' in surface ? 'project' : 'profile';
    const profile = typeof surface === 'object' && 'publicProfile' in surface ? surface.publicProfile : undefined;
    // The resolver uses the target kind and presentation; project identity belongs to its settings hook.
    const target = React.useMemo(() => surface, [surfaceKind, profile]);
    const settings = React.useMemo(() => selectAtmosphereSettings(target, home, projectOverride), [target, home, projectOverride]);
    const localId = atmospherePictureLocalId(settings);
    const pictureRef = settings.picture.ref;
    const builtin = settings.source === 'picture' && pictureRef.kind === 'builtin'
        ? pictures.find(picture => picture.id === pictureRef.id) : undefined;
    const stored = useStoredPictureRecord(localId);

    // A failed download leaves the planet visible. Revisiting/remounting or choosing again tries once more.
    React.useEffect(() => {
        if (builtin) void pictureStore.ensureBuiltin(builtin).catch(() => {});
    }, [builtin]);

    const shown = React.useRef<ResolvedAtmosphere<(typeof pictures)[number]> | null>(null);
    const environmentReduceTransparency = glassEnvironment.reduceTransparency;
    const resolved = React.useMemo(() => resolveAtmosphere({ surface: target, home, projectOverride, pictures,
        pictureRecord: stored.status === 'present' ? stored.record : undefined,
        shownPicture: shown.current, readingPicture: stored.status === 'loading',
        isPhone, glassEnvironment: { reduceTransparency: environmentReduceTransparency },
        reduceTransparency, reducedMotion }), [target, home, projectOverride, pictures, stored, localId,
        isPhone, environmentReduceTransparency, reduceTransparency, reducedMotion]);
    shown.current = resolved;
    return resolved;
}
