import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useOptionalUniversalSearchRuntime } from '@/components/appShell/search/UniversalSearchRuntimeContext';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Text } from '@/components/ui/text/Text';
import { DiffStat } from '@/components/workspaces/scm/DiffStat';
import { createSessionScmReviewDetailsTab } from './sessionDetailsTabBuilders';
import { Typography } from '@/constants/Typography';
import { selectScmChangedFiles, type ScmFileStatus } from '@/scm/scmStatusFiles';
import { useSessionProjectScmSnapshot, useWorkspaceScmTouchedPathsForSession } from '@/sync/domains/state/storage';
import { t } from '@/text';

const STATUS_LETTER: Readonly<Record<ScmFileStatus['status'], string>> = {
    modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!',
};

/**
 * A Session's editor column with nothing open (lab ade-shell EM1): the page invites opening a file
 * beside the session (Open file… is the one primary action, the files search), then lists what this
 * session changed so the next read is one press away. In Editor first the column is permanent, so
 * this is what the centre shows until a file opens. It mounts only while Details is empty, so the
 * always-mounted panel never subscribes to the working tree.
 */
export const SessionDetailsEmptyState = React.memo(function SessionDetailsEmptyState(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    openDetailsTab: AppPaneScopeApi['openDetailsTab'];
}>) {
    const { theme } = useUnistyles();
    const search = useOptionalUniversalSearchRuntime();
    const snapshot = useSessionProjectScmSnapshot(props.sessionId, props.serverId ?? undefined);
    const touched = useWorkspaceScmTouchedPathsForSession(props.sessionId, props.serverId);
    // The one change-count truth (the rail badge, the Git header and quick open read it too),
    // narrowed to the files this session touched.
    const changed = React.useMemo(() => {
        if (snapshot?.repo.isRepo !== true || touched.length === 0) return [];
        const paths = new Set(touched);
        return selectScmChangedFiles(snapshot).filter(file => paths.has(file.fullPath));
    }, [snapshot, touched]);
    const reviewCount = snapshot?.repo.isRepo === true ? selectScmChangedFiles(snapshot).length : 0;
    const openDetailsTab = props.openDetailsTab;
    const openFile = React.useCallback((file: ScmFileStatus) => {
        openDetailsTab(createWorkspaceFileDetailsTab(file.fullPath), { intent: 'pinned' });
    }, [openDetailsTab]);
    const openReview = React.useCallback(() => {
        openDetailsTab(createSessionScmReviewDetailsTab(), { intent: 'pinned' });
    }, [openDetailsTab]);
    const openSearch = React.useCallback(() => {
        search?.open(undefined, undefined, { source: 'files' });
    }, [search]);

    return (
        <ScrollView testID="pane-details-empty-state" style={styles.scroll} contentContainerStyle={styles.content}>
            <EmptyState
                layout="centered"
                size="details"
                iconName="file"
                title={t('panes.emptyEditor.title')}
                subtitle={t('panes.emptyEditor.reason')}
                primaryAction={search ? { label: t('panes.emptyEditor.openFile'), onPress: openSearch, testID: 'pane-empty-editor-open-file' } : undefined}
                // Reading every change at once stays one press away (the canonical changed-file count).
                secondaryAction={reviewCount > 0 ? { label: t('detailsSurface.chrome.reviewChanges', { count: reviewCount }), onPress: openReview, testID: 'pane-empty-editor-review' } : undefined}
            />
            {changed.length > 0 ? (
                <View style={styles.changed}>
                    <View style={styles.changedHeader}>
                        <Text style={styles.changedTitle}>{t('panes.emptyEditor.changedInSession')}</Text>
                        <Text style={styles.changedCount}>{changed.length}</Text>
                    </View>
                    {changed.map(file => (
                        <HappierPressable
                            key={file.fullPath}
                            testID={`pane-empty-editor-changed-${file.fullPath}`}
                            accessibilityRole="button"
                            accessibilityLabel={t('panes.emptyEditor.openChangedFileA11y', { name: file.fileName })}
                            onPress={() => openFile(file)}
                            style={({ hovered, pressed }) => [styles.row, hovered || pressed ? { backgroundColor: theme.colors.surface.selected } : null]}
                        >
                            {/* Only an added file takes the add colour; M stays quiet ink (lab DIRECTION). */}
                            <Text style={[styles.letter, file.status === 'added' ? { color: theme.colors.diff.success } : null]}>
                                {STATUS_LETTER[file.status]}
                            </Text>
                            <Text numberOfLines={1} style={styles.name}>{file.fileName}</Text>
                            <Text numberOfLines={1} ellipsizeMode="middle" style={styles.dir}>{file.filePath}</Text>
                            <View style={styles.grow} />
                            <DiffStat added={file.linesAdded} removed={file.linesRemoved} />
                        </HappierPressable>
                    ))}
                </View>
            ) : null}
        </ScrollView>
    );
});

/** The Changed list keeps a reading measure under the centred state, like the lab's. */
const CHANGED_LIST_MAX_WIDTH_PX = 560;

const styles = StyleSheet.create((theme) => ({
    scroll: { flex: 1 },
    content: { flexGrow: 1, justifyContent: 'center', paddingVertical: theme.space.s32, paddingHorizontal: theme.space.s16 },
    changed: { alignSelf: 'center', width: '100%', maxWidth: CHANGED_LIST_MAX_WIDTH_PX, marginTop: theme.space.s48 },
    changedHeader: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s8, paddingHorizontal: theme.space.s8, marginBottom: theme.space.s6 },
    changedTitle: { ...Typography.variant('meta', 'semiBold'), color: theme.colors.text.secondary },
    changedCount: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minHeight: 36, paddingHorizontal: theme.space.s8, borderRadius: theme.space.s8 },
    letter: { ...Typography.mono(), ...Typography.variant('micro'), width: 12, color: theme.colors.text.secondary },
    name: { ...Typography.variant('body', 'semiBold'), color: theme.colors.text.primary, flexShrink: 0, maxWidth: '50%' },
    dir: { ...Typography.variant('meta'), color: theme.colors.text.secondary, flexShrink: 1, minWidth: 0 },
    grow: { flex: 1 },
}));
