import * as React from 'react';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useHappierCollectionVisit } from '@happier-dev/plugin-ui/presentation';

import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { RemoteHostsActiveTask, RemoteHostsCollectionRoot, RemoteHostsRail } from './collection/RemoteHostsCollection';

import { REMOTE_HOSTS_ROOT, recordRemoteHostVisit, resolveVisitedRemoteHostId } from './collection/remoteHostsRoutes';

/** The narrowest page that still fits an SSH field beside its label. */
const REMOTE_HOSTS_DETAIL_MIN_WIDTH_PX = 480;

function resolveRemoteHostsChildRoute(pathname: string): string {
    if (pathname === REMOTE_HOSTS_ROOT) return 'index';
    const rest = pathname.slice(REMOTE_HOSTS_ROOT.length + 1);
    if (rest === 'new' || rest === 'access') return rest;
    return '[hostId]';
}

const identity = (hostId: string) => hostId;

/**
 * Remote hosts as a collection: saved hosts beside the open host (or the new-host draft, or this
 * device's keys and connections). Narrow: the list page pushes each page.
 */
export const RemoteHostsSettingsLayout = React.memo(function RemoteHostsSettingsLayout() {
    // Beside the rail and in the pushed list alike, the opened host is what a wide collection lands on.
    useHappierCollectionVisit(recordRemoteHostVisit, resolveVisitedRemoteHostId(usePathname().replace(/\/+$/, '')), identity);
    return (
        <RemoteHostsCollectionRoot>
            <SettingsCollectionLayout
                navigator="remote-hosts"
                rootPathname={REMOTE_HOSTS_ROOT}
                resolveChildRoute={resolveRemoteHostsChildRoute}
                rail={<RemoteHostsRail />}
                railWidth="standard"
                detailMinWidthPx={REMOTE_HOSTS_DETAIL_MIN_WIDTH_PX}
                testID="settings-remote-hosts"
                detailTop={<RemoteHostsActiveTask />}
            />
        </RemoteHostsCollectionRoot>
    );
});
