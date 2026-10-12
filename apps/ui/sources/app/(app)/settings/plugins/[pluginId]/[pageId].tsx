import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { PluginSettingsPageScreen } from '@/components/settings/plugins/PluginSettingsPageScreen';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { readPluginSettingsPageRouteParams } from '@/components/settings/catalog/runtime/pluginSettingsPageCatalog';

export const WorkspaceRouteBody = React.memo(function PluginSettingsPageRoute() {
    const params = useLocalSearchParams();
    const route = readPluginSettingsPageRouteParams(params);

    return (
        <PluginSettingsPageScreen
            pluginId={route?.pluginId ?? null}
            pageId={route?.pageId ?? null}
            subPath={route ? route.subPath : undefined}
        />
    );
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() {
    return <WorkspaceRouteEntry Body={WorkspaceRouteBody}
        loadingFallback={<PluginSurfaceFallback testID="plugin-settings-page-hydrating" state="loading" />} />;
}
