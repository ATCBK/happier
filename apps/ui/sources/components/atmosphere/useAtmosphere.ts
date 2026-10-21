import * as React from 'react';
import { useAtmospherePictureCatalog } from './useAtmospherePictureCatalog';
import { useSetting, useProjectAtmosphere } from '@/sync/store/hooks';
import { useGlassRuntimeEnvironment } from '@/components/ui/glass/glassRuntimeEnvironment';
import { useReduceTransparency } from '@/hooks/ui/useReduceTransparency';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useDeviceType } from '@/utils/platform/responsive';
import { pictureStore } from './pictureStore';
import type { PictureRecord } from './pictureStore.types';
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
    const settings = selectAtmosphereSettings(surface, home, projectOverride);
    const localId = atmospherePictureLocalId(settings);
    const pictureRef = settings.picture.ref;
    const builtin = settings.source === 'picture' && pictureRef.kind === 'builtin'
        ? pictures.find(picture => picture.id === pictureRef.id) : undefined;
    const revision = React.useSyncExternalStore(pictureStore.subscribe, pictureStore.getRevision, () => 0);
    const [stored, setStored] = React.useState<Readonly<{ localId: string | null; record?: PictureRecord }>>({ localId: null });

    React.useEffect(() => {
        let disposed = false;
        if (localId === null) return;
        void pictureStore.get(localId).then(record => {
            if (!disposed) setStored({ localId, record });
        }, () => {
            if (!disposed) setStored({ localId });
        });
        return () => { disposed = true; };
    }, [localId, revision]);

    // A failed download leaves the planet visible. Revisiting/remounting or choosing again tries once more.
    React.useEffect(() => {
        if (builtin) void pictureStore.ensureBuiltin(builtin).catch(() => {});
    }, [builtin]);

    const shown = React.useRef<ResolvedAtmosphere<(typeof pictures)[number]> | null>(null);
    const resolved = resolveAtmosphere({ surface, home, projectOverride, pictures,
        pictureRecord: stored.localId === localId ? stored.record : undefined,
        shownPicture: shown.current, readingPicture: localId !== null && stored.localId !== localId,
        isPhone, glassEnvironment,
        reduceTransparency, reducedMotion });
    shown.current = resolved;
    return resolved;
}
