import * as React from 'react';
import { useLocalSearchParams, usePathname } from 'expo-router';
import { useOptionalWorkspaceNavigation } from './WorkspaceNavigationContext';
import { useDestinationInstanceKey } from './DestinationInstanceHost';
import { WorkspaceRouteHostingContext } from './WorkspaceRouteHostingContext';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';

/** The Expo entry is only the URL sink when the workspace hosts its body. */
export function WorkspaceRouteEntry(props: Readonly<{ Body: React.ComponentType; mirror?: React.ReactNode; loadingFallback?: React.ReactNode }>) {
    const workspace = useOptionalWorkspaceNavigation();
    const hosted = useDestinationInstanceKey() !== null;
    const pathname = usePathname();
    const params = useLocalSearchParams();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (Array.isArray(value)) for (const part of value) query.append(key, part);
        else if (typeof value === 'string') query.append(key, value);
    }
    const ownsHref = React.useContext(WorkspaceRouteHostingContext);
    // Expo may commit this scene before its browser-history mirror. Consult the
    // workspace owner's route admission, not its preceding active-URL projection.
    const ownsRoute = ownsHref ? ownsHref(`${pathname}${query.size ? `?${query}` : ''}`) : workspace?.ownsRoute;
    if (!hosted && ownsRoute && !workspace?.active) {
        // A temporary Expo body would lose edits when hydration admits the retained host.
        // Layout mirrors must stay mounted: Expo still owns their URL serialization.
        return <>{props.mirror ?? props.loadingFallback ?? <PaneLoadingFallback testID="workspace-route-hydrating" />}</>;
    }
    return workspace?.active === true && !hosted ? <>{props.mirror}</> : <props.Body />;
}
