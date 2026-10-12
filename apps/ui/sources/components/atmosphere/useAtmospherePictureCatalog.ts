import * as React from 'react';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveAtmospherePictureCatalog } from './pictureCatalog';

export function useAtmospherePictureCatalog() {
    const family = useAppShellPluginUiProjection().pluginUiProjection?.atmospherePicturesById;
    return React.useMemo(() => resolveAtmospherePictureCatalog(family ? { atmospherePicturesById: family } : null), [family]);
}
