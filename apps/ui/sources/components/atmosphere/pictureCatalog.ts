import { ATMOSPHERE_PICTURES, type AtmospherePicture } from '@happier-dev/brand/atmosphere';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';

export function resolveAtmospherePictureCatalog(projection: Pick<PluginUiProjectionModel, 'atmospherePicturesById'> | null): readonly AtmospherePicture[] {
    const entries = Object.values(projection?.atmospherePicturesById ?? {});
    if (entries.length === 0) return ATMOSPHERE_PICTURES;
    return Object.freeze([...ATMOSPHERE_PICTURES, ...entries.map(entry => Object.freeze({ ...entry.definition, id: entry.id }))]);
}

/** The current catalog outside React (settings normalization, Actions): built-ins plus the committed plugin pictures. */
export function readAtmospherePictureCatalog(): readonly AtmospherePicture[] {
    return resolveAtmospherePictureCatalog(readCurrentAppShellPluginUiProjection());
}
