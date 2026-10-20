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
 * The header title of a widget card, for every host (Home, WorkBoard): its name when one is known (its own, its
 * definition's, or for an unnamed installed widget the plugin's own name while the plugin is known to the app);
 * a skeleton line while the name is still on its way (an Artifact definition loading, or the plugin projection not
 * current yet); and, once that has settled with no name, the generic kind word. A card whose surface cannot mount
 * here is thus named by what it belongs to or by its kind, never by a placeholder or a loading line that never ends.
 */
export function useWidgetFrameTitle(instance: WidgetInstanceV1, candidate: Readonly<{ title: string }> | null | undefined): string | React.ReactElement {
    const { pluginUiProjection, phase } = useAppShellPluginUiProjection();
    const own = readWidgetInstanceName(instance, candidate);
    const installedName = own === null && instance.definition.kind === 'installed'
        ? pluginUiProjection?.installedPackagesById[instance.definition.surface.pluginId]?.displayName.trim() || null
        : null;
    const name = own ?? installedName;
    if (name !== null) return name;
    return instance.definition.kind === 'artifact' || phase !== 'current' ? <WidgetFrameTitleSkeleton /> : t('boards.widgets.kind');
}

/** The header's title line while the name is not known yet: it keeps the title's room, so arrival moves nothing. */
function WidgetFrameTitleSkeleton(): React.ReactElement {
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
