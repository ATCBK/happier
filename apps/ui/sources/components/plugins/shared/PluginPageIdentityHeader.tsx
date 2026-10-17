import * as React from 'react';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginMark } from '@/components/settings/plugins/PluginMark';
import { PageHeader } from '@/components/ui/layout/PageHeader';

import { PluginSurfacePageHeaderContext } from './pluginSurfaceInteractionAvailability';

/**
 * A plugin page route's identity (its title and the package's mark, with the route's own controls such
 * as Run on) for the moment its surface has loaded nothing: a live page draws its own header, a page
 * that never loaded keeps this one above its cold state (`PluginSurfaceInteractionBoundary`).
 */
export function PluginPageIdentityHeaderProvider(props: Readonly<{
    pluginId: string;
    title: string;
    children: React.ReactNode;
}>): React.ReactElement {
    const app = useAppShellPluginUiProjection();
    const installedPackage = app.pluginUiProjection?.installedPackagesById[props.pluginId] ?? null;
    const header = React.useMemo(() => (
        <PageHeader
            testID={`plugin-page-identity-header:${props.pluginId}`}
            title={props.title}
            leading={<PluginMark title={props.title} pluginId={props.pluginId} size="page"
                installedPackage={installedPackage} machineId={app.machineId} serverId={app.serverId} />}
        />
    ), [app.machineId, app.serverId, installedPackage, props.pluginId, props.title]);
    return <PluginSurfacePageHeaderContext.Provider value={header}>{props.children}</PluginSurfacePageHeaderContext.Provider>;
}
