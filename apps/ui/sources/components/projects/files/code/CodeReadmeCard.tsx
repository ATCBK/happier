import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

import { useCodeTextFile } from './useCodeTextFile';

/** A folder's README, the one GitHub and every forge render below the listing. */
export function findCodeReadmePath(entries: ReadonlyArray<Readonly<{ name: string; path: string; type: string }>>): string | null {
    const readme = entries.find((entry) => entry.type === 'file' && /^readme(\.(md|markdown|mdx|txt))?$/i.test(entry.name));
    return readme?.path ?? null;
}

/**
 * The README under a Code folder's table (lab p-code BROWSE): its name, a way to edit it, and the
 * rendered text. A folder without one shows nothing — the page ends after the files. It is the last
 * section of the table's own sheet, so the folder reads as one card that scrolls once (the lab drew it
 * as a second card; a nested card inside the scrolling table read as a card in a card).
 */
export const CodeReadmeCard = React.memo(function CodeReadmeCard(props: Readonly<{
    testID?: string;
    scope: WorkspaceScopeBase;
    path: string;
    onEdit?: ((path: string) => void) | null;
    /** The checkout's directory revision: the page's Refresh (and any listing change) reads the README again. */
    reloadToken?: number;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const testID = props.testID ?? 'code-readme';
    // Retry reads the same file again; the last text stays on screen while it does.
    const [retry, setRetry] = React.useState(0);
    const file = useCodeTextFile(props.scope, props.path, `${props.reloadToken ?? 0}:${retry}`);
    const name = props.path.split('/').pop() ?? props.path;
    return (
        <View testID={testID} style={styles.section}>
            <View style={styles.header}>
                <Icon name="book-open" size={16} color={theme.colors.text.secondary} />
                <Text numberOfLines={1} style={styles.name}>{name}</Text>
                <View style={styles.grow} />
                {props.onEdit ? (
                    <IconButton
                        testID={`${testID}-edit`}
                        variant="plain"
                        size={26}
                        iconName="pencil-simple"
                        accessibilityLabel={t('common.edit')}
                        tooltip={t('common.edit')}
                        onPress={() => props.onEdit?.(props.path)}
                    />
                ) : null}
            </View>
            <View style={styles.body}>
                {file.kind === 'ready' ? (
                    <MarkdownView testID={`${testID}-markdown`} markdown={file.text} renderCacheKey={props.path} />
                ) : file.kind === 'error' ? (
                    // The same one-line state and Retry as the Overview README widget.
                    <SurfaceStateCard testID={`${testID}-error`} size="line" kind="error" title={t('projects.code.readUnavailable')}
                        action={{ label: t('common.retry'), onPress: () => setRetry(value => value + 1), testID: `${testID}-error-action` }} />
                ) : (
                    <View aria-busy style={styles.skeleton}>
                        <HappierSkeletonBlock width="40%" height={18} radius={6} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
                        <HappierSkeletonBlock width="86%" height={10} radius={5} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
                        <HappierSkeletonBlock width="72%" height={10} radius={5} color={theme.colors.surface.skeleton} reducedMotion={reducedMotion} />
                    </View>
                )}
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    section: {
        borderTopWidth: StyleSheet.hairlineWidth || 1,
        borderTopColor: theme.colors.border.subtle,
    },
    header: {
        minHeight: 44,
        paddingLeft: 14,
        paddingRight: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderBottomWidth: StyleSheet.hairlineWidth || 1,
        borderBottomColor: theme.colors.border.subtle,
    },
    name: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    grow: {
        flex: 1,
    },
    body: {
        paddingHorizontal: 24,
        paddingVertical: 20,
    },
    skeleton: {
        gap: 12,
    },
}));
