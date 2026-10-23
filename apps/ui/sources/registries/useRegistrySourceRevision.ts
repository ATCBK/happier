import * as React from 'react';
import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { projectPluginRegistrySources } from './pluginRegistrySources';

/** Existing Account row and declaration publication jointly invalidate registry reads. */
export function useRegistrySourceRevision(): string {
    const catalog = usePromptLibraryCatalogValue('registry-sources');
    const registrySourcesById = useAppShellPluginUiProjection(value => value.pluginUiProjection?.registrySourcesById);
    return React.useMemo(() => JSON.stringify([catalog.revision,
        projectPluginRegistrySources(registrySourcesById ? { registrySourcesById } : null),
    ]), [catalog.revision, registrySourcesById]);
}
