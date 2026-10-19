import * as React from 'react';
import { View } from 'react-native';
import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { HappierSkeletonBlock, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

/**
 * What a widget is called before anything fetched says so: its own name, its definition's title, or the
 * name an inline definition carries. `null` while none is known, so no placeholder word stands in for it.
 */
export function readWidgetInstanceName(instance: WidgetInstanceV1, candidate: Readonly<{ title: string }> | null | undefined): string | null {
    return instance.displayName ?? candidate?.title ?? (instance.definition.kind === 'inline' ? instance.definition.definition.name : null);
}

/**
 * The same name, and for a widget of an installed plugin that has no name of its own yet, the plugin's own
 * name while the plugin is known to the app: a card whose surface cannot mount here is still named by
 * what it belongs to, never by a placeholder word.
 */
export function useWidgetInstanceName(instance: WidgetInstanceV1, candidate: Readonly<{ title: string }> | null | undefined): string | null {
    const installed = useAppShellPluginUiProjection().pluginUiProjection?.installedPackagesById;
    const own = readWidgetInstanceName(instance, candidate);
    if (own !== null || instance.definition.kind !== 'installed') return own;
    return installed?.[instance.definition.surface.pluginId]?.displayName.trim() || null;
}

/** The header's title line while the name is not known yet: it keeps the title's room, so arrival moves nothing. */
export function WidgetFrameTitleSkeleton(): React.ReactElement {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    return (
        <View accessible accessibilityLabel={t('common.loading')} style={styles.line}>
            <HappierSkeletonBlock width={96} height={10} radius={5} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    line: { justifyContent: 'center', height: happierPageTextMetrics('sectionTitle').lineHeight },
}));
