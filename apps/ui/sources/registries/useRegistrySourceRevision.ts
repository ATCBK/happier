import { usePromptLibraryCatalogValue } from '@/sync/store/usePromptLibraryCatalog';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { projectPluginRegistrySources } from './pluginRegistrySources';

/** Existing Account row and declaration publication jointly invalidate registry reads. */
export function useRegistrySourceRevision(): string {
    const catalog = usePromptLibraryCatalogValue('registry-sources');
    const { pluginUiProjection } = useAppShellPluginUiProjection();
    return JSON.stringify([catalog.revision, projectPluginRegistrySources(pluginUiProjection)]);
}
