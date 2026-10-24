import * as React from 'react';
import { listRegistrySourcesV1, type RegistrySourcesRecordV1 } from '@happier-dev/protocol/registries';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { projectPluginRegistrySources } from '@/registries/pluginRegistrySources';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { getPromptLibraryCatalogValue, subscribePromptLibraryCatalogSnapshots } from '@/sync/store/settings/promptLibraryCatalogSnapshot';
import { createSkillSourceNameResolver } from './skillSource';

const NO_CONFIGURED_SOURCES: RegistrySourcesRecordV1 = { v: 2, sources: [], disabledSourceIds: [] };

/** Presentation subscribes to held catalog facts; it never starts a registry/catalog read. */
export function useSkillSourceNames() {
  const scope = useAccountSettingsScope();
  const read = React.useCallback(() => getPromptLibraryCatalogValue(scope, 'registry-sources'), [scope]);
  const snapshot = React.useSyncExternalStore(subscribePromptLibraryCatalogSnapshots, read, read);
  const registrySourcesById = useAppShellPluginUiProjection(value => value.pluginUiProjection?.registrySourcesById);
  return React.useMemo(() => createSkillSourceNameResolver(listRegistrySourcesV1({
    record: snapshot.value ?? NO_CONFIGURED_SOURCES,
    pluginSources: projectPluginRegistrySources(registrySourcesById ? { registrySourcesById } : null),
  })), [registrySourcesById, snapshot.value]);
}
