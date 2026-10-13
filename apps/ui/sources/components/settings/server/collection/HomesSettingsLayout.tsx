import * as React from 'react';

import { RelayDriftNotice } from '@/components/settings/server/RelayDriftNotice';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { HomesCollectionProvider, HomesCollectionRail, useHomesCollection } from './HomesCollection';
import { HOMES_COLLECTION_ROOT } from './homeCollectionModel';

/** The narrowest page that still fits a Home page's header actions beside its title. */
const HOMES_DETAIL_MIN_WIDTH_PX = 480;

function resolveHomesChildRoute(pathname: string): string {
    if (pathname === HOMES_COLLECTION_ROOT) return 'index';
    const rest = pathname.slice(HOMES_COLLECTION_ROOT.length + 1);
    if (rest === 'add' || rest === 'device' || rest === 'groups/new') return rest;
    if (rest.startsWith('groups/')) return 'groups/[groupId]';
    return '[homeId]';
}

/** This computer's daemon serving another Home concerns every Homes page, so it shows above the open one. */
const HomesRelayDriftNotice = React.memo(function HomesRelayDriftNotice() {
    const { controller } = useHomesCollection();
    return controller.relayDriftBanner
        ? <RelayDriftNotice banner={controller.relayDriftBanner} testID="settings.server.relayDrift.readOnlyNotice" />
        : null;
});

/**
 * Settings → Homes as a collection (lab `add-flows` H1): this device, the Homes it knows and their
 * groups beside the open page — a Home, this device's connection, a group, or a Home being added.
 * Narrow: the list page pushes each page.
 */
export const HomesSettingsLayout = React.memo(function HomesSettingsLayout() {
    return (
        <HomesCollectionProvider>
            <SettingsCollectionLayout
                navigator="server"
                rootPathname={HOMES_COLLECTION_ROOT}
                resolveChildRoute={resolveHomesChildRoute}
                rail={<HomesCollectionRail />}
                railWidth="standard"
                detailMinWidthPx={HOMES_DETAIL_MIN_WIDTH_PX}
                testID="settings-homes"
                detailTop={<HomesRelayDriftNotice />}
            />
        </HomesCollectionProvider>
    );
});
