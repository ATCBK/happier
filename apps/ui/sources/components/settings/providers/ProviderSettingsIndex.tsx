import * as React from 'react';
import { Redirect, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { SettingSection, useSettingRevealRequested } from '@/components/settings/shell/SettingRow';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useProviderSettingsTarget } from '@/providers/hooks/targetMachine';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { ProviderConnectionsSettingsScreen } from './ProviderConnectionsSettingsScreen';
import { useClaimProviderCollectionPane } from './ProviderSettingsLayout';
import { ProviderCollectionInvitation } from './collection/ProviderCollectionInvitation';
import { PROVIDERS_SETTINGS } from './providersSettings';
import { ProviderErrorItems } from './ProviderErrorItems';
import { ProviderFeatureAvailabilityNotice, useProviderFeatureAvailability } from './ProviderFeatureAvailability';
import {
    buildProviderCollection,
    providerConnectionDetailRoute,
    readLastVisitedProviderConnectionId,
    resolveProviderCollectionLandingId,
} from './collection/providerCollectionModel';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

const PROVIDER_COLLECTION_SETTINGS = Object.values(PROVIDERS_SETTINGS.settings);

/**
 * `/settings/providers`. Beside the rail the index normally lands on a selected provider;
 * with nothing to select it is a warm invitation to add the first. Where no rail shows, the index is
 * the provider list and each row pushes its detail. Search keeps requested collection controls visible.
 */
export const ProviderSettingsIndex = React.memo(function ProviderSettingsIndex() {
    const view = useHappierCollectionIndexView();
    const collectionSettingRequested = useSettingRevealRequested(PROVIDER_COLLECTION_SETTINGS);
    if (view === 'pending') return null;
    if (view === 'land' && !collectionSettingRequested) return <ProviderCollectionLanding />;
    return <ProviderConnectionsSettingsScreen variant="page" />;
});

const ProviderCollectionLanding = React.memo(function ProviderCollectionLanding() {
    const router = useRouter();
    const focused = useIsFocused();
    const styles = stylesheet;
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const localDiscoveryEnabled = useFeatureEnabled('providers.localDiscovery');
    const providerTarget = useProviderSettingsTarget();
    const { machineId, accountServerId: serverId, accountAddressAvailable } = providerTarget;
    const { data, error, loading, refresh, declarationContext } = useProviderConnections({ enabled: enabled && accountAddressAvailable, active: focused, machineId, serverId });
    const collection = React.useMemo(() => buildProviderCollection({
        data, query: '', localDiscoveryEnabled, declarationContext,
    }), [data, localDiscoveryEnabled, declarationContext]);
    const navigate = React.useCallback((href: string) => {
        const result = runGuardedNavigation(() => router.replace(href as never));
        if (result !== true) fireAndForget(result, { tag: 'ProviderCollectionLanding.navigate' });
    }, [router]);

    const landingId = resolveProviderCollectionLandingId(collection.connections, readLastVisitedProviderConnectionId());
    const unreadable = !availabilityPresentation && !data && Boolean(error) && !loading;
    // Wait for the collection's answer so the invitation never flashes over an existing collection.
    const waiting = !availabilityPresentation && !unreadable && (loading || !data);
    // Every state but a landing on a provider (or the wait for one) is a whole-page state.
    useClaimProviderCollectionPane(!landingId && !waiting);

    if (landingId) return <Redirect href={providerConnectionDetailRoute(landingId) as never} />;

    if (availabilityPresentation) {
        return (
            <ItemList>
                <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections} answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
                    <ItemGroup><ProviderFeatureAvailabilityNotice presentation={availabilityPresentation} /></ItemGroup>
                </SettingSection>
            </ItemList>
        );
    }
    // The collection could not be read: say what failed with its recovery, never a blank pane.
    if (unreadable && error) {
        return (
            <ItemList>
                <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections} answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
                <ItemGroup>
                    <ProviderErrorItems error={error} retry={async () => { await refresh(); }} />
                </ItemGroup>
                </SettingSection>
            </ItemList>
        );
    }
    if (waiting) return (
        <ItemList containerStyle={styles.centeredPane}>
            <SurfaceStateCard testID="settings-providers-loading" kind="loading" title={t('common.loading')} replacesContent />
        </ItemList>
    );
    if (!data) return <ItemList>{null}</ItemList>;

    // With nothing to list the invitation owns the whole pane, centred in it (lab PI1).
    return (
        <ItemList containerStyle={styles.centeredPane}>
            <SettingSection section={PROVIDERS_SETTINGS.sectionRefs.connections} answersFor={[PROVIDERS_SETTINGS.sectionRefs.local]}>
                <ProviderCollectionInvitation available={data.available} onAdd={navigate} />
            </SettingSection>
        </ItemList>
    );
});

const stylesheet = StyleSheet.create({
    centeredPane: {
        flexGrow: 1,
        justifyContent: 'center',
    },
});
