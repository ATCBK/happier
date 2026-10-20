import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useSettingsParentBack } from '@/components/settings/navigation/settingsRouteRegistry';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RegistrySourcesView } from '@/registries/RegistrySourcesView';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
import { useNavigationChromeShowsBack } from '@/components/ui/layout/navigationTitleChrome';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useDeviceType } from '@/utils/platform/responsive';

function sourceHref(sourceId: string): string {
    return `${SETTINGS_ROUTES.pluginSources}?source=${encodeURIComponent(sourceId)}`;
}

/**
 * Settings → Plugins → Sources (P4 U6, F5): the same Registries view the Add modals open one level in, here as the
 * page body for plugin sources — built-in, added by a plugin, and the ones the person added.
 *
 * A phone pushes the open source as the page's query state (`?source=`, like a Machine Defaults category): the header's
 * Back resolves it to the list (`resolveSettingsRouteParentPathname`) and then leaves the page. A wide page keeps the
 * open source beside the list.
 */
export const PluginSourcesScreen = React.memo(function PluginSourcesScreen() {
    // The phone's floating tab bar overlays the page: the registries view (list, and the details pane's footer) sits above it.
    const chromeClearance = useFloatingChromeClearance();
    const phone = useDeviceType() === 'phone';
    const navigationShowsBack = useNavigationChromeShowsBack();
    const router = useRouter();
    const { goToParent } = useSettingsParentBack('PluginSourcesScreen.back');
    const { source } = useLocalSearchParams<{ source?: string | string[] }>();
    const routedSource = (Array.isArray(source) ? source[0] : source) ?? null;
    const selection = React.useMemo(() => phone && navigationShowsBack ? {
        value: routedSource,
        onChange: (next: string | null) => {
            if (next === null) { goToParent(); return; }
            const href = sourceHref(next);
            const result = runGuardedNavigation(() => routedSource === null ? router.push(href as never) : router.replace(href as never));
            if (result !== true) fireAndForget(result, { tag: 'PluginSourcesScreen.open' });
        },
    } : undefined, [goToParent, navigationShowsBack, phone, routedSource, router]);
    // A pushed detail is the page: the list's purpose line no longer sits above it.
    const detailPushed = selection !== undefined && routedSource !== null;
    return (
        <View style={styles.page} testID="settings.plugins.sources">
            <SettingsPageHeader {...(detailPushed ? {} : { description: t('settingsPlugins.sourceAdministration.subtitle') })} />
            <View style={[styles.body, chromeClearance > 0 ? { paddingBottom: chromeClearance } : null]}>
                <PageContentColumn>
                    <ListPresentationProvider value="page" pageInsets="contained">
                        <RegistrySourcesView kind="plugin" pageSheet {...(selection ? { selection } : {})} testID="settings.plugins.sources.registries" />
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
