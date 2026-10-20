import * as React from 'react';
import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { buildPluginsHomeRoute, readPluginListingRouteParams } from '../model/pluginsSurfaceRoutes';
import { usePluginsSurfaceHost } from '../model/usePluginsSurfaceHost';
import { PluginListingScreen } from './PluginListingScreen';

/**
 * The listing route of either host (Settings or the app page). A deep link that does not name both
 * the source and the plugin lands on the Plugins home of the same host.
 */
export const PluginListingRoute = React.memo(function PluginListingRoute() {
    const host = usePluginsSurfaceHost();
    const listing = readPluginListingRouteParams(useLocalSearchParams());
    if (!listing) return <Redirect href={buildPluginsHomeRoute(host)} />;
    return <PluginListingScreen sourceId={listing.sourceId} pluginId={listing.pluginId} />;
});
