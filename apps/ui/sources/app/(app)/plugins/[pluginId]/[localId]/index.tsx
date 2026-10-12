import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { PluginAppPageScreen } from '@/components/appShell/plugins/PluginAppPageScreen';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { readPluginAppPageRouteIdentity } from '@/components/appShell/plugins/pluginAppPageRoute';

export const WorkspaceRouteBody = React.memo(function PluginAppPageRootRoute() {
    const identity = readPluginAppPageRouteIdentity(useLocalSearchParams());

    return (
        <PluginAppPageScreen
            pluginId={identity.pluginId}
            localId={identity.localId}
            subPath=""
        />
    );
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() {
    return <WorkspaceRouteEntry Body={WorkspaceRouteBody}
        loadingFallback={<PluginSurfaceFallback testID="plugin-app-page-hydrating" state="loading" />} />;
}
