import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RegistrySourcesView } from '@/registries/RegistrySourcesView';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { t } from '@/text';

/**
 * Settings → Plugins → Sources (P4 U6, F5): the same Registries view the Add modals open one level in, here as the
 * page body for plugin sources — built-in, added by a plugin, and the ones the person added.
 */
export const PluginSourcesScreen = React.memo(function PluginSourcesScreen() {
    // The phone's floating tab bar overlays the page: the registries view (list, and the details pane's footer) sits above it.
    const chromeClearance = useFloatingChromeClearance();
    // A phone's pushed detail is the page: the list's purpose line no longer sits above it.
    const [detailPushed, setDetailPushed] = React.useState(false);
    return (
        <View style={styles.page} testID="settings.plugins.sources">
            <SettingsPageHeader {...(detailPushed ? {} : { description: t('settingsPlugins.sourceAdministration.subtitle') })} />
            <View style={[styles.body, chromeClearance > 0 ? { paddingBottom: chromeClearance } : null]}>
                <PageContentColumn>
                    <ListPresentationProvider value="page" pageInsets="contained">
                        <RegistrySourcesView kind="plugin" pageSheet onDetailPushedChange={setDetailPushed} testID="settings.plugins.sources.registries" />
                    </ListPresentationProvider>
                </PageContentColumn>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
    // The registries sit a step under the header's purpose line.
    body: { flex: 1, minHeight: 0, paddingTop: theme.space.s16 },
}));
