import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RegistrySourcesView } from '@/registries/RegistrySourcesView';
import { t } from '@/text';

/**
 * Settings → Plugins → Sources (P4 U6, F5): the same Registries view the Add modals open one level in, here as the
 * page body for plugin sources — built-in, added by a plugin, and the ones the person added.
 */
export const PluginSourcesScreen = React.memo(function PluginSourcesScreen() {
    return (
        <View style={styles.page} testID="settings.plugins.sources">
            <SettingsPageHeader description={t('settingsPlugins.sourceAdministration.subtitle')} />
            <View style={styles.body}>
                <RegistrySourcesView kind="plugin" testID="settings.plugins.sources.registries" />
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    page: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base },
    body: { flex: 1, minHeight: 0 },
}));
