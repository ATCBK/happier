import * as React from 'react';

import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';
import { useProfile } from '@/sync/store/hooks';

import { ConnectedServicesRail } from './ConnectedServicesRail';
import { CONNECTED_SERVICES_COLLECTION_ROUTE, resolveConnectedServicesChildRoute } from './connectedServicesCollectionRoutes';

/** The narrowest detail that still fits an account's identity beside its meters. */
const CONNECTED_SERVICES_DETAIL_MIN_WIDTH_PX = 560;

/**
 * Connected services as a collection (lab `csvc` C1): the rail of services (each expanding to its
 * accounts), pools and code hosts beside the detail. With nothing selected the detail is the index of
 * every service (a designed overview, `COLLECTION-REQUIREMENTS.md` §2.1 exception); selecting an account
 * or a pool opens it. Narrow: the index page is the list and pushes each detail.
 */
export const ConnectedServicesSettingsLayout = React.memo(function ConnectedServicesSettingsLayout() {
    // First run (lab P0): nothing connected yet, so no rail; the index is the whole page.
    const profile = useProfile();
    const hasAccounts = (profile.connectedAccountsV4?.length ?? 0) > 0
        || (profile.connectedServicesV2 ?? []).some((service) => (service.profiles?.length ?? 0) > 0);
    return (
        <SettingsCollectionLayout
            navigator="connected-services"
            rootPathname={CONNECTED_SERVICES_COLLECTION_ROUTE}
            resolveChildRoute={resolveConnectedServicesChildRoute}
            rail={hasAccounts ? <ConnectedServicesRail /> : null}
            railWidth="standard"
            detailMinWidthPx={CONNECTED_SERVICES_DETAIL_MIN_WIDTH_PX}
            testID="settings-connected-services"
        />
    );
});
