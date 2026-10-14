import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierBreadcrumb } from '@happier-dev/plugin-ui/presentation';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { SearchResultsList } from '@/components/workspaces/files/repositoryTree/SearchResultsList';
import { useWorkspaceFileQuery } from '@/sync/domains/workspaces/files/useWorkspaceFileQuery';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

/** One step of a Code location: the root (the project's name) or a folder/file under it. */
export type CodeBreadcrumbSegment = Readonly<{ path: string; label: string }>;

/** `apps/ui/sources` → root, `apps`, `apps/ui`, `apps/ui/sources`. */
export function buildCodeBreadcrumbSegments(rootLabel: string, path: string): CodeBreadcrumbSegment[] {
    const parts = path.split('/').filter((part) => part.length > 0);
    const segments: CodeBreadcrumbSegment[] = [{ path: '', label: rootLabel }];
    parts.forEach((part, index) => {
        segments.push({ path: parts.slice(0, index + 1).join('/'), label: part });
    });
    return segments;
}

/**
 * The line above a Code folder or file (lab p-code BROWSE/FILE): where you are, as a breadcrumb whose
 * every ancestor goes back to its folder page, and Go to file, the workspace's file search.
 */
export const CodeBrowserBar = React.memo(function CodeBrowserBar(props: Readonly<{
    testID?: string;
    scope: WorkspaceScopeBase;
    rootLabel: string;
    path: string;
    onNavigateFolder: (path: string) => void;
    onOpenFile: (path: string) => void;
    fileHref?: (path: string) => string | null;
    /** `false` in the Overview widget: Go to file belongs to the Code page. */
    goToFile?: boolean;
    /** Phone layout keeps nested up navigation above a full-width Go to file field. */
    compact?: boolean;
    /** The folder's own controls (View, +), at the end of the line after Go to file. */
    trailing?: React.ReactNode;
    /** One quiet status on the bar's own line (an approval waiting), so it never pushes the page down. */
    status?: React.ReactNode;
}>) {
    const testID = props.testID ?? 'code-browser-bar';
    const { theme } = useUnistyles();
    const segments = React.useMemo(() => buildCodeBreadcrumbSegments(props.rootLabel, props.path), [props.path, props.rootLabel]);
    return (
        <View testID={testID} style={[styles.bar, props.compact ? styles.barCompact : null]}>
            {props.compact && props.path === '' ? null : <HappierBreadcrumb accessibilityRole="header" style={styles.crumbs}
                separator={<Text style={styles.separator}>/</Text>}
                linkStyle={styles.crumb}
                colors={{ focus: theme.colors.border.focus, hover: theme.colors.surface.pressed }}
                items={segments.map((segment, index) => {
                    const current = index === segments.length - 1;
                    return { key: segment.path || '/', label: segment.label, testID: current ? `${testID}-current` : `${testID}-crumb-${index}`, onPress: current ? undefined : () => props.onNavigateFolder(segment.path) };
                })}
                renderLabel={(item) => <Text testID={item.onPress ? undefined : item.testID} numberOfLines={1} style={item.onPress ? styles.crumbLabel : styles.current}>{item.label}</Text>}
            />}
            {props.compact ? null : <View style={[styles.grow, styles.growRow]}>{props.status ? <View style={styles.status}>{props.status}</View> : null}</View>}
            <View style={props.compact ? styles.toolsCompact : styles.tools}>
                {props.goToFile === false ? null : <CodeGoToFile testID={`${testID}-goto`} scope={props.scope} onOpenFile={props.onOpenFile} onOpenFolder={props.onNavigateFolder} fileHref={props.fileHref} compact={props.compact} />}
                {props.trailing}
            </View>
            {props.compact && props.status ? <View style={styles.statusCompact}>{props.status}</View> : null}
        </View>
    );
});

/**
 * Go to file: the workspace file search (`workspace.files.search`'s owner) under a compact field; the
 * results drop beneath it. A folder result goes to its page, a file opens.
 */
function CodeGoToFile(props: Readonly<{
    testID: string;
    scope: WorkspaceScopeBase;
    onOpenFile: (path: string) => void;
    onOpenFolder: (path: string) => void;
    fileHref?: (path: string) => string | null;
    compact?: boolean;
}>) {
    const { theme } = useUnistyles();
    const anchorRef = React.useRef<View>(null);
    const [query, setQuery] = React.useState('');
    const open = query.trim().length > 0;
    const fileQuery = useWorkspaceFileQuery({ scope: props.scope, query, enabled: open, limit: 50 });
    const close = React.useCallback(() => setQuery(''), []);
    return (
        <View ref={anchorRef} collapsable={false} style={props.compact ? styles.gotoCompact : styles.goto}>
            <CompactSearchField
                testID={props.testID}
                value={query}
                onChangeText={setQuery}
                placeholder={t('projects.code.goToFile')}
            />
            <Popover open={open} anchorRef={anchorRef} placement="bottom" onRequestClose={close} maxHeightCap={360}>
                {({ maxHeight }) => (
                    <FloatingOverlay maxHeight={maxHeight}>
                        <View style={{ height: Math.min(maxHeight, 320) }}>
                            <SearchResultsList
                                theme={theme}
                                workspaceScope={props.scope}
                                fileHref={props.fileHref}
                                isSearching={fileQuery.isSearching}
                                searchQuery={query}
                                searchResults={fileQuery.items}
                                searchResultsQuery={fileQuery.resultQuery}
                                searchError={Boolean(fileQuery.error)}
                                hasMore={fileQuery.hasMore}
                                onRetry={fileQuery.retry}
                                onFolderPress={(folder) => { close(); props.onOpenFolder(folder.fullPath.replace(/\/+$/, '')); }}
                                onFilePress={(file) => { close(); props.onOpenFile(file.fullPath); }}
                            />
                        </View>
                    </FloatingOverlay>
                )}
            </Popover>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 32,
        marginBottom: 12,
    },
    crumbs: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 4,
        flexShrink: 1,
        minWidth: 0,
    },
    barCompact: {
        flexDirection: 'column',
        alignItems: 'stretch',
    },
    crumb: {
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderRadius: 6,
    },
    crumbLabel: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.link,
    },
    current: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
        paddingHorizontal: 4,
        paddingVertical: 2,
    },
    separator: {
        ...Typography.variant('label', 'semiBold'),
        ...Typography.default('regular'),
        color: theme.colors.text.tertiary,
    },
    grow: {
        flex: 1,
        minWidth: 0,
    },
    growRow: {
        flexDirection: 'row',
        alignSelf: 'stretch',
        alignItems: 'center',
    },
    // The status takes the bar's free space after the breadcrumb, ending at Go to file.
    status: {
        flex: 1,
        flexDirection: 'row',
        minWidth: 0,
        paddingHorizontal: theme.space.s4,
    },
    statusCompact: {
        flexDirection: 'row',
        minWidth: 0,
    },
    tools: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    toolsCompact: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
        alignSelf: 'stretch',
    },
    goto: {
        width: 240,
    },
    gotoCompact: {
        flex: 1,
        minWidth: 0,
    },
}));
