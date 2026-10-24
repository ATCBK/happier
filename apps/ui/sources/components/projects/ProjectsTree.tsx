import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HAPPIER_COLLECTION_LIST_METRICS,
    HAPPIER_TREE_ROW_METRICS,
    HappierTreeDisclosure,
    useHappierTreeInteraction,
    type HappierTreeNode,
} from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { CollectionListGroupLabel, CollectionNavigationRow } from '@/components/ui/lists/collection/CollectionList';
import {
    ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX,
    ITEM_SUBTITLE_TEXT_METRICS,
    ITEM_TITLE_TEXT_METRICS,
} from '@/components/ui/lists/itemDensityMetrics';
import { SkeletonRows } from '@/components/ui/lists/SkeletonRows';
import { scaleTextStyle } from '@/components/ui/text/uiFontScale';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    applyProjectsTreeCheckoutFacts,
    buildProjectsTreeRows,
    projectsTreeCheckoutKey,
    projectsTreeRowSubtitle,
    type ProjectsTreeProject,
    type ProjectsTreeRow,
} from './projectsTreeRows';
import { useProjectsTreeCheckoutFactsFor, type ProjectsTreeCheckoutFactsSource } from './useProjectsTreeCheckoutFacts';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

/**
 * The Projects tree's keyboard and semantics through the shared tree owner (`useHappierTreeInteraction`):
 * treeitem levels and expanded state, one roving tab stop, arrows/Home/End move, Right/Left/Space
 * disclose, Enter activates (a leaf opens its exact checkout; a parent toggles). Focus repairs to the
 * nearest visible ancestor when a branch closes or a Project is hidden. The column and the phone list
 * both bind their rows through it — there is no Projects-specific keyboard engine.
 */
export function useProjectsTreeKeyboard(rows: readonly ProjectsTreeRow[], handlers: Readonly<{
    onToggle: (key: string) => void;
    onOpenRow: (row: ProjectsTreeRow) => void;
}>) {
    const visibleNodes = React.useMemo((): HappierTreeNode[] => {
        const ancestors: ProjectsTreeRow[] = [];
        return rows.map((row) => {
            while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.level >= row.level) ancestors.pop();
            const node: HappierTreeNode = {
                key: row.key,
                parentKey: ancestors[ancestors.length - 1]?.key ?? null,
                depth: row.level,
                kind: row.expandable ? 'branch' : 'leaf',
                expanded: row.expanded,
            };
            if (row.expandable) ancestors.push(row);
            return node;
        });
    }, [rows]);
    const rowsRef = React.useRef(rows);
    rowsRef.current = rows;
    const handlersRef = React.useRef(handlers);
    handlersRef.current = handlers;
    const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
    const tree = useHappierTreeInteraction({
        visibleNodes,
        focusedKey,
        onFocus: setFocusedKey,
        onExpandedChange: (key, expanded) => {
            const row = rowsRef.current.find((candidate) => candidate.key === key);
            if (row && row.expanded !== expanded) handlersRef.current.onToggle(key);
        },
        onActivate: (key) => {
            const row = rowsRef.current.find((candidate) => candidate.key === key);
            if (row) handlersRef.current.onOpenRow(row);
        },
    });
    const getRowProps = React.useCallback((row: ProjectsTreeRow): NonNullable<React.ComponentProps<typeof CollectionNavigationRow>['treeItem']> => ({
        webRole: 'treeitem',
        webTabIndex: row.key === tree.activeKey ? 0 : -1,
        accessibilityLevel: row.level + 1,
        accessibilityExpanded: row.expandable ? row.expanded : undefined,
        pressableRef: (target) => tree.bindFocusTarget(row.key, target?.focus ? { focus: () => target.focus?.() } : null),
        onFocus: () => tree.onFocusChange(row.key, true),
        onBlur: () => tree.onFocusChange(row.key, false),
        onKeyDown: (event) => {
            const key = event.nativeEvent?.key ?? event.key;
            if (key && tree.onKeyDown(row.key, key, event)) event.preventDefault?.();
        },
    }), [tree]);
    return { getRowProps };
}

/** Where a row's action lands: a leaf opens its exact checkout, a parent opens or closes in place. */
function openTreeRow(row: ProjectsTreeRow, onOpenRef: (refId: string, address?: WorkspaceAddressV1) => void, onToggle: (key: string) => void) {
    if (row.refId) onOpenRef(row.refId, row.workspaceAddress);
    else if (row.expandable) onToggle(row.key);
}

export type ProjectsTreeLiveCheckoutsInput = Readonly<{
    source: ProjectsTreeCheckoutFactsSource;
    /** The Projects the structural rows were built from, without checkout facts. */
    projects: readonly ProjectsTreeProject[];
    openRefId: string | null;
    expandedKeys: ReadonlySet<string>;
    collapsedKeys?: ReadonlySet<string>;
}>;
type ProjectsTreeLiveCheckouts = ProjectsTreeLiveCheckoutsInput & Readonly<{ projectsByKey: ReadonlyMap<string, ProjectsTreeProject> }>;

export type ProjectsTreeHiddenItem = Readonly<{ key: string; title: string; subtitle: string; refId?: string; workspaceAddress?: WorkspaceAddressV1 }>;
export type ProjectsTreeSavedItem = Readonly<{ key: string; title: string; subtitle?: string }>;

/**
 * The Projects column's tree (plan 10 §2/§8, lab p-projects TREE/HIDE/HIDDEN): Projects, their
 * machines and checkouts as `buildProjectsTreeRows` folds them; parents disclose, leaves open their
 * exact checkout. Your saved Sources that are not open sit dimmed after them, and hidden Projects
 * collect in one Hidden group at the end, each with Show.
 */
export const ProjectsTree = React.memo(function ProjectsTree(props: Readonly<{
    testID?: string;
    /**
     * Structural rows (membership, level, disclosure) when `live` is given; already-presented rows otherwise.
     */
    rows: readonly ProjectsTreeRow[];
    /** Live checkout facts per Project, read below the tree by each Project's own section. */
    live?: ProjectsTreeLiveCheckoutsInput | null;
    onToggle: (key: string) => void;
    onOpenRef: (refId: string, address?: WorkspaceAddressV1) => void;
    /** A row's own menu (New session here, Save as a source, Hide project). */
    renderRowMenu?: ((row: ProjectsTreeRow) => React.ReactNode) | null;
    hrefForRef?: ((refId: string, address?: WorkspaceAddressV1) => string | null) | null;
    saved?: Readonly<{ items: readonly ProjectsTreeSavedItem[]; onOpen: (key: string) => void }> | null;
    hidden?: Readonly<{
        items: readonly ProjectsTreeHiddenItem[];
        open: boolean;
        onToggle: () => void;
        onShow: (key: string) => void;
    }> | null;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const testID = props.testID ?? 'projects-tree';
    const { onOpenRef, onToggle } = props;
    const keyboard = useProjectsTreeKeyboard(props.rows, {
        onToggle,
        onOpenRow: (row) => openTreeRow(row, onOpenRef, onToggle),
    });
    const disclosureColumn = props.rows.some((candidate) => candidate.expandable);
    const liveInput = props.live;
    const live = React.useMemo((): ProjectsTreeLiveCheckouts | null => liveInput ? {
        ...liveInput,
        projectsByKey: new Map(liveInput.projects.map((project) => [project.key, project] as const)),
    } : null, [liveInput]);
    const rowListProps: ProjectsTreeRowListProps = {
        testID,
        disclosureColumn,
        getRowProps: keyboard.getRowProps,
        renderRowMenu: props.renderRowMenu,
        hrefForRef: props.hrefForRef,
        onOpenRef,
        onToggle,
    };
    return (
        <View testID={testID} {...(Platform.OS === 'web' ? { role: 'tree' as const } : {})}>
            {live ? (
                projectRuns(props.rows).map((run) => (
                    <ProjectsTreeLiveSection key={run[0]!.key} rows={run} live={live} rowList={rowListProps} />
                ))
            ) : (
                <ProjectsTreeRowList rows={props.rows} {...rowListProps} />
            )}
            {props.saved && props.saved.items.length > 0 ? (
                <>
                    <CollectionListGroupLabel testID={`${testID}-saved`} title={t('projects.identity.savedNotOpen')} count={props.saved.items.length} />
                    {props.saved.items.map((item) => (
                        <CollectionNavigationRow
                            key={item.key}
                            testID={`${testID}-saved-${item.key}`}
                            title={item.title}
                            subtitle={item.subtitle}
                            icon={<Icon name="folder" size={16} color={theme.colors.text.tertiary} />}
                            dimmed
                            selected={false}
                            rightElement={<Text style={styles.count}>{t('projects.identity.notOpen')}</Text>}
                            onPress={() => props.saved?.onOpen(item.key)}
                        />
                    ))}
                </>
            ) : null}
            {props.hidden && props.hidden.items.length > 0 ? (
                // Hidden Projects (lab p-projects HIDE/HIDDEN): one disclosure row through the column's own
                // row and turning chevron, then each hidden Project as an ordinary dimmed row with Show.
                <View style={[styles.hidden, { borderTopColor: theme.colors.border.subtle }]}>
                    <CollectionNavigationRow
                        testID={`${testID}-hidden`}
                        title={t('projects.identity.hiddenTitle')}
                        titleQualifier={String(props.hidden.items.length)}
                        accessibilityLabel={t('projects.identity.hiddenCount', { count: props.hidden.items.length })}
                        leftElement={(
                            <View style={styles.leading}>
                                <HappierTreeDisclosure
                                    kind="branch"
                                    expanded={props.hidden.open}
                                    color={theme.colors.text.tertiary}
                                    reducedMotion={reducedMotion}
                                />
                                <Icon name="eye-slash" size={16} color={theme.colors.text.secondary} />
                            </View>
                        )}
                        treeItem={{ accessibilityExpanded: props.hidden.open }}
                        dimmed
                        selected={false}
                        onPress={props.hidden.onToggle}
                    />
                    {props.hidden.open ? props.hidden.items.map((item) => (
                        <CollectionNavigationRow
                            key={item.key}
                            testID={`${testID}-hidden-${item.key}`}
                            href={item.refId ? props.hrefForRef?.(item.refId, item.workspaceAddress) ?? null : null}
                            title={item.title}
                            subtitle={item.subtitle}
                            leftElement={(
                                <View style={styles.leading}>
                                    {disclosureColumn ? <HappierTreeDisclosure kind="leaf" expanded={false} color={theme.colors.text.tertiary} reducedMotion={reducedMotion} /> : null}
                                    <Icon name="folder" size={16} color={theme.colors.text.tertiary} />
                                </View>
                            )}
                            dimmed
                            selected={false}
                            rightElement={(
                                <ToolbarButton
                                    testID={`${testID}-show-${item.key}`}
                                    label={t('projects.identity.show')}
                                    accessibilityLabel={`${t('projects.identity.show')} ${item.title}`}
                                    onPress={() => props.hidden?.onShow(item.key)}
                                />
                            )}
                            // Hidden is not unreachable: the row still opens its exact checkout.
                            onPress={() => { if (item.refId) onOpenRef(item.refId, item.workspaceAddress); }}
                        />
                    )) : null}
                </View>
            ) : null}
        </View>
    );
});

type ProjectsTreeRowListProps = Readonly<{
    testID: string;
    disclosureColumn: boolean;
    getRowProps: ReturnType<typeof useProjectsTreeKeyboard>['getRowProps'];
    renderRowMenu?: ((row: ProjectsTreeRow) => React.ReactNode) | null;
    hrefForRef?: ((refId: string, address?: WorkspaceAddressV1) => string | null) | null;
    onOpenRef: (refId: string, address?: WorkspaceAddressV1) => void;
    onToggle: (key: string) => void;
}>;

/** The tree's rows as drawn: one shared row anatomy for every Project section. */
function ProjectsTreeRowList(props: ProjectsTreeRowListProps & Readonly<{ rows: readonly ProjectsTreeRow[] }>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    return (
        <>
            {props.rows.map((row) => {
                const leading = (
                    <View style={styles.leading}>
                        {props.disclosureColumn ? (
                            // The shared turning chevron; the row itself toggles (parents disclose, leaves navigate).
                            <HappierTreeDisclosure
                                kind={row.expandable ? 'branch' : 'leaf'}
                                expanded={row.expanded}
                                color={theme.colors.text.tertiary}
                                reducedMotion={reducedMotion}
                            />
                        ) : null}
                        <Icon
                            name={row.glyph === 'project' ? 'folder' : row.glyph === 'machine' ? 'desktop' : 'git-branch'}
                            size={16}
                            color={theme.colors.text.secondary}
                        />
                    </View>
                );
                const trailing = (
                    <View style={styles.trailing}>
                        {row.count != null ? <Text style={styles.count}>{String(row.count)}</Text> : null}
                        {row.attention === 'needs-you' ? (
                            <StatusDot testID={`${props.testID}-${row.key}-needs-you`} color={theme.colors.state.warning.foreground} size={6}
                                accessibilityLabel={t('projects.checkouts.needsYou')} />
                        ) : row.attention === 'working' ? (
                            <ActivitySpinner size="small" color={theme.colors.text.tertiary} />
                        ) : null}
                        {props.renderRowMenu?.(row) ?? null}
                    </View>
                );
                return (
                    <CollectionNavigationRow
                        key={row.key}
                        testID={`${props.testID}-row-${row.key}`}
                        href={row.refId ? props.hrefForRef?.(row.refId, row.workspaceAddress) ?? null : null}
                        title={row.title}
                        titleQualifier={row.titleQualifier}
                        subtitle={projectsTreeRowSubtitle(row, t('projects.identity.newFromSession')) ?? undefined}
                        subtitleMono={row.kind === 'checkout' && row.subtitle != null}
                        leftElement={leading}
                        selected={row.selected}
                        dimmed={row.offline === true}
                        indentPx={row.level * HAPPIER_TREE_ROW_METRICS.indentStepPx}
                        treeItem={props.getRowProps(row)}
                        accessibilityLabel={row.titleQualifier ? `${row.title}, ${row.titleQualifier}` : row.title}
                        rightElement={trailing}
                        onPress={() => openTreeRow(row, props.onOpenRef, props.onToggle)}
                    />
                );
            })}
        </>
    );
}

/** The structural rows (level 0 starts a Project) grouped per Project. */
function projectRuns(rows: readonly ProjectsTreeRow[]): ProjectsTreeRow[][] {
    const runs: ProjectsTreeRow[][] = [];
    for (const row of rows) {
        if (row.level === 0 || runs.length === 0) runs.push([row]);
        else runs[runs.length - 1]!.push(row);
    }
    return runs;
}

/**
 * One Project's rows with their live checkout facts. The section subscribes to its own checkouts' facts,
 * so a change to one checkout re-renders this Project only; the tree above keeps membership, focus and
 * keyboard order and is not involved.
 */
function ProjectsTreeLiveSection(props: Readonly<{
    rows: readonly ProjectsTreeRow[];
    live: ProjectsTreeLiveCheckouts;
    rowList: ProjectsTreeRowListProps;
}>) {
    const { live } = props;
    const project = live.projectsByKey.get(props.rows[0]!.key);
    const keys = (project?.checkouts ?? []).map(projectsTreeCheckoutKey);
    const facts = useProjectsTreeCheckoutFactsFor(live.source, keys);
    const rows = project
        ? buildProjectsTreeRows({
            projects: [applyProjectsTreeCheckoutFacts(project, (_checkout, index) => facts[index] ?? null)],
            openRefId: live.openRefId,
            expandedKeys: live.expandedKeys,
            collapsedKeys: live.collapsedKeys,
        })
        : props.rows;
    return <ProjectsTreeRowList rows={rows} {...props.rowList} />;
}

/** The tree's leading anatomy: the disclosure column, then the row's glyph (`styles.leading`). */
const TREE_LEADING_GAP_PX = 8;
const TREE_GLYPH_PX = 16;
const PROJECTS_TREE_SKELETON_GEOMETRY = Object.freeze({
    insetStart: HAPPIER_COLLECTION_LIST_METRICS.contentInset + HAPPIER_TREE_ROW_METRICS.disclosureBoxPx + TREE_LEADING_GAP_PX,
    insetEnd: HAPPIER_COLLECTION_LIST_METRICS.contentInset,
    glyphColumn: TREE_GLYPH_PX,
    glyphSize: TREE_GLYPH_PX,
    gap: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap,
});
const PROJECTS_TREE_SKELETON_ROW_BOX = Object.freeze({
    minHeight: HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight,
    paddingVertical: ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX.compact,
});

/**
 * The Projects tree's first load: the shared loading rows in the tree rows' own shape — a compact
 * navigation row with a subtitle, its glyph after the disclosure column, its title and subtitle at their
 * line heights in the user's font scale — so the rows that land replace them without a shift.
 */
export const ProjectsTreeSkeletonRows = React.memo(function ProjectsTreeSkeletonRows(props: Readonly<{ rows: number; testID?: string }>) {
    const uiFontScale = useLocalSetting('uiFontScale');
    const lineHeights = React.useMemo(() => {
        const scaled = (lineHeight: number) => {
            const style = scaleTextStyle({ lineHeight }, uiFontScale) as { lineHeight?: number };
            return style.lineHeight ?? lineHeight;
        };
        return [scaled(ITEM_TITLE_TEXT_METRICS.compact.lineHeight), scaled(ITEM_SUBTITLE_TEXT_METRICS.compact.lineHeight)] as const;
    }, [uiFontScale]);
    return (
        <SkeletonRows
            {...(props.testID === undefined ? {} : { testID: props.testID })}
            rows={props.rows}
            rowBox={PROJECTS_TREE_SKELETON_ROW_BOX}
            lineHeights={lineHeights}
            geometry={PROJECTS_TREE_SKELETON_GEOMETRY}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    leading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: TREE_LEADING_GAP_PX,
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    count: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
    },
    hidden: {
        marginTop: theme.space.s12,
        paddingTop: theme.space.s8,
        borderTopWidth: StyleSheet.hairlineWidth || 1,
    },
}));
