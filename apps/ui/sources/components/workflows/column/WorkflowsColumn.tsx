import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { getBuiltinWorkflowCatalogV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { HAPPIER_COLLECTION_LIST_METRICS, HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SessionsList } from '@/components/sessions/shell/SessionsList';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemList } from '@/components/ui/lists/ItemList';
import { CollectionList, CollectionListGroupLabel, CollectionNavigationRow, CollectionSkeletonRows, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useViewportClass } from '@/utils/platform/useViewportClass';
import { HomeReachabilityGate, useActiveHomeUnavailable } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { AccountTriggersSection } from '@/components/workflows/triggers/AccountTriggersSection';
import type { WorkflowLibraryDefinition } from '@/components/workflows/library/workflowLibraryReads';
import type { WorkflowLibraryRunSummary } from '@/components/workflows/library/useWorkflowLibrarySummaries';
import { useWorkflowLibraryView, type WorkflowLibraryViewController } from '@/components/workflows/library/useWorkflowLibraryView';
import { useWorkflowLibrarySpaceHeader } from '@/components/workflows/library/useWorkflowLibrarySpaceHeader';
import { hasWorkingWorkflowLibraryRun } from '@/components/workflows/library/workflowRunStrip';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { formatTriggerSetSummary } from '@/components/workflows/triggers/formatTriggerSummary';
import { createWorkflowDefinitionRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t, tLoose } from '@/text';
import { formatWorkflowDefinitionContentUnavailableReason, formatWorkflowDefinitionLibraryTitle } from '@/components/workflows/presentation/workflowProblemPresentation';

import { WorkflowsColumnActions } from './WorkflowsColumnActions';
import { WorkflowsColumnOwnsCreationContext } from './workflowsColumnCreation';
import { WorkflowPurposeGlyph } from '../presentation/WorkflowPurposeGlyph';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';

type WorkflowsColumnView = 'definitions' | 'runs';

function isRunPath(pathname: string): boolean {
    return /^\/workflows\/runs(?:\/|$)/.test(pathname);
}

function readOpenDefinition(pathname: string): string | null {
    const match = /^\/workflows\/([^/?#]+)$/.exec(pathname);
    if (!match || ['new', 'runs', 'settings', 'edit'].includes(match[1]!)) return null;
    try { return decodeURIComponent(match[1]!); } catch { return match[1]!; }
}

/** Definitions and the canonical Sessions list's Runs view share the destination's column. */
export const WorkflowsColumn = React.memo(function WorkflowsColumn(props: Readonly<{ surface?: 'plane' | 'page'; definitionsContent?: React.ReactNode }>) {
    const access = useWorkflowsDestinationAccess();
    // On a phone the home's header actions would either fold into a second overflow of raw buttons
    // (navigation shows the title) or stack three buttons under the purpose line (a phone-sized web
    // window); the column's own "+" menu (lab `nav-N1m` rows, P1's one way to add) carries creation instead.
    const titleChrome = useNavigationTitleChromeShowsTitle();
    const phone = useViewportClass() === 'compact';
    const ownsCreation = (titleChrome || phone) && props.definitionsContent !== undefined;
    const pathname = usePathname();
    const params = useGlobalSearchParams<{ trigger?: string }>();
    const [view, setView] = React.useState<WorkflowsColumnView>(() => isRunPath(pathname) ? 'runs' : 'definitions');
    React.useEffect(() => {
        if (params.trigger) setView('definitions');
        else if (isRunPath(pathname)) setView('runs');
        else if (readOpenDefinition(pathname)) setView('definitions');
    }, [pathname, params.trigger]);
    // As the page the switch is a row of its own on the sheets' edge; in the column it is the compact icon
    // switch in the band under the title (WorkflowsColumnList), never in the title row.
    // With no navigation chrome above it (a phone browser, an installed web app) the switch is the page's first
    // row and clears the device's top edge itself; under a native header it only needs the page's own breathing room.
    const safeAreaTop = useChromeSafeAreaInsets().top;
    const viewTabs = <View style={[styles.views, styles.viewsOnPage, { paddingTop: HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx + (titleChrome ? 0 : safeAreaTop) }]}>
            <View style={styles.viewTabs}>
                <SegmentedTabBar<WorkflowsColumnView>
                testIDPrefix="workflows-column:view"
                accessibilityLabel={t('workflows.tabsAccessibility.savedRuns')}
                tabs={[
                    { id: 'definitions', label: t('workflows.list.definitions') },
                    { id: 'runs', label: t('workflows.tabs.runs') },
                ]}
                activeTabId={view}
                onSelectTab={setView}
                segmentSizing="equal"
                />
            </View>
            {props.definitionsContent === undefined ? null : <WorkflowsColumnActions canCreate={ownsCreation} />}
        </View>;
    // Without a shell column, Definitions is the full home, not a second compact navigation list.
    // The same view owner still reaches Runs; the home carries its own page identity, actions and spaces.
    if (props.definitionsContent !== undefined && access.kind === 'workflows') {
        return <View testID="workflows-column" style={styles.column}>
            {viewTabs}
            {view === 'runs' ? <SessionsList fixedShow="runs" pathname={pathname} /> : (
                <WorkflowsColumnOwnsCreationContext.Provider value={ownsCreation}>{props.definitionsContent}</WorkflowsColumnOwnsCreationContext.Provider>
            )}
        </View>;
    }
    const headerAction = access.kind === 'workflows' || access.kind === 'triggersOnly'
        ? <WorkflowsColumnActions canCreate={access.kind === 'workflows'} /> : null;
    if (access.kind === 'workflows') {
        return <View testID="workflows-column" style={styles.column}>
            <WorkflowsColumnList surface={props.surface ?? 'plane'} view={view} onSelectView={setView} headerAction={headerAction} pathname={pathname} />
        </View>;
    }
    return <View testID="workflows-column" style={styles.column}>
        <CollectionList
            testID="workflows-column:list"
            surface={props.surface ?? 'plane'}
            title={t('workflows.title')}
            headerAction={headerAction}
        >
            {access.kind === 'triggersOnly' ? <AccountTriggersSection first /> : null}
        </CollectionList>
    </View>;
});

/**
 * The column's one list (R9, R8-7): Definitions and Runs switch inside the same list and header, so the
 * switch's thumb glides and nothing above it moves: it lives in the band under the title in both views. Definitions carry the saved-space title, strip and
 * condition editor over the one Workflow library controller the library home also reads; Runs keep the
 * Sessions list's own sessionWork controls and never take a definition space.
 */
const WorkflowsColumnList = React.memo(function WorkflowsColumnList(props: Readonly<{
    surface: 'plane' | 'page';
    view: WorkflowsColumnView;
    onSelectView: (view: WorkflowsColumnView) => void;
    headerAction: React.ReactNode;
    pathname: string;
}>) {
    const presented = useLayoutPresentationActive();
    const libraryView = useWorkflowLibraryView(presented);
    const header = useWorkflowLibrarySpaceHeader(libraryView, 'workflows-column-space');
    const definitions = props.view === 'definitions';
    const { theme } = useUnistyles();
    const viewSwitch = <SegmentedTabBar<WorkflowsColumnView>
        testIDPrefix="workflows-column:view"
        accessibilityLabel={t('workflows.tabsAccessibility.savedRuns')}
        compact
        segmentSizing="content"
        tabs={[
            { id: 'definitions', label: t('workflows.list.definitions'), icon: <Icon name="tree-structure" size={15} color={theme.colors.text.secondary} /> },
            { id: 'runs', label: t('workflows.tabs.runs'), icon: <Icon name="play-circle" size={15} color={theme.colors.text.secondary} /> },
        ]}
        activeTabId={props.view}
        onSelectTab={props.onSelectView}
    />;
    return <CollectionList
        testID="workflows-column:list"
        surface={props.surface}
        title={t('workflows.title')}
        {...(definitions ? { titleControl: header.titleControl } : {})}
        strip={<>
            <View testID="workflows-column:view-band" style={styles.viewBand}>
                <View style={styles.viewBandLead}>{definitions ? header.strip : null}</View>
                {viewSwitch}
            </View>
            {header.overlays}
        </>}
        headerAction={<View style={styles.headerActions}>{definitions ? header.filterButton : null}{props.headerAction}</View>}
        scrollContent={definitions ? <ItemList presentation="grouped" style={styles.definitionsList}>
            <WorkflowsColumnDefinitions libraryView={libraryView} />
        </ItemList> : <SessionsList fixedShow="runs" pathname={props.pathname} />}
    />;
});

const WorkflowsColumnDefinitions = React.memo(function WorkflowsColumnDefinitions(props: Readonly<{
    libraryView: WorkflowLibraryViewController;
}>) {
    const router = useRouter();
    const pathname = usePathname();
    const selectedDefinitionId = readOpenDefinition(pathname);
    const homeUnavailable = useActiveHomeUnavailable();
    const { library, summaries, isVisible } = props.libraryView;
    const split = React.useMemo(() => ({
        library: props.libraryView.split.library.filter((definition) => isVisible(definition.definitionId)),
        sharedWithYou: props.libraryView.split.sharedWithYou.filter((definition) => isVisible(definition.definitionId)),
        fromPlugins: props.libraryView.split.fromPlugins.filter((plugin) => isVisible(plugin.workflow)),
    }), [isVisible, props.libraryView.split]);
    const firstLoad = library.status === 'loading' && library.definitions.length === 0;
    const libraryFailed = library.status === 'failed' && library.definitions.length === 0 && !homeUnavailable;
    return <>
        {homeUnavailable ? <View style={styles.freshness}><HomeReachabilityGate variant="line">{null}</HomeReachabilityGate></View> : null}
        <CollectionListGroupLabel testID="workflows-column:group:library" title={t('workflows.destination.sections.library')} countPlacement="title"
            {...(split.library.length > 0 ? { count: split.library.length } : {})} first />
        {firstLoad ? <CollectionSkeletonRows count={3} /> : null}
        {libraryFailed ? <View style={collectionListStyles.stateLine}><SurfaceStateCard testID="workflows-column:library:failed" size="line" kind="error"
            title={t('workflows.loadFailedTitle')} reason={t('workflows.loadFailedBody')} action={{ label: t('workflows.retry'), onPress: library.retry, testID: 'workflows-column:library:failed:retry' }}
            accessibilitySemantics="alert" /></View> : null}
        {library.status === 'loaded' && split.library.length === 0 ? <EmptyState testID="workflows-column:library:empty"
            layout="line" title={t('workflows.destination.libraryEmpty')} /> : null}
        {split.library.map((definition) => {
            const life = readDefinitionLife(summaries?.get(definition.definitionId));
            const title = formatWorkflowDefinitionLibraryTitle(definition);
            return <CollectionNavigationRow key={definition.definitionId}
                href={`/workflows/${encodeURIComponent(definition.definitionId)}`} testID={`workflows-column:library:${definition.definitionId}`}
                title={title} icon={<Icon name="tree-structure" />} selected={selectedDefinitionId === definition.definitionId}
                {...(definitionSubtitle(definition) === null ? {} : { subtitle: definitionSubtitle(definition)! })}
                {...(life.kind === 'needsYou' || life.kind === 'running' ? {
                    status: <WorkStatusGlyph testIDSuffix={`workflow-definition-${definition.definitionId}`}
                        status={resolveWorkStatusTone({ kind: 'workflow', facts: {
                            word: t(life.kind === 'needsYou' ? 'workflows.destination.sections.needsYou' : 'workflows.destination.sections.running'),
                            needsYouCount: life.kind === 'needsYou' ? 1 : 0, hasActiveRun: life.kind === 'running' } })} />,
                    accessibilityLabel: `${title}, ${t(life.kind === 'needsYou' ? 'workflows.destination.sections.needsYou' : 'workflows.destination.sections.running')}`,
                } : {})}
                {...(life.kind === 'rested' ? { detail: life.age } : {})}
                onPress={() => router.push(`/workflows/${encodeURIComponent(definition.definitionId)}` as never)} />;
        })}
        <AccountTriggersSection />
        {split.sharedWithYou.length > 0 ? <>
            <CollectionListGroupLabel testID="workflows-column:group:sharedWithYou" title={t('workflows.destination.sections.sharedWithYou')} countPlacement="title"
                count={split.sharedWithYou.length} />
            {split.sharedWithYou.map((definition) => <CollectionNavigationRow key={definition.definitionId}
                href={`/workflows/${encodeURIComponent(definition.definitionId)}`} testID={`workflows-column:shared:${definition.definitionId}`}
                title={formatWorkflowDefinitionLibraryTitle(definition)} icon={<Icon name="tree-structure" />} selected={selectedDefinitionId === definition.definitionId}
                {...(definition.contentStatus === 'unavailable' ? { subtitle: formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason) } : {})}
                onPress={() => router.push(`/workflows/${encodeURIComponent(definition.definitionId)}` as never)} />)}
        </> : null}
        <ColumnBuiltins selectedDefinitionId={selectedDefinitionId} isVisible={isVisible} />
        {split.fromPlugins.length > 0 ? <>
            <CollectionListGroupLabel testID="workflows-column:group:fromPlugins" title={t('workflows.plugins.fromPlugins')} countPlacement="title"
                count={split.fromPlugins.length} />
            {split.fromPlugins.map((workflow) => <CollectionNavigationRow key={workflow.workflow}
                href={`/workflows/${encodeURIComponent(workflow.workflow)}`} testID={`workflows-column:plugin:${workflow.workflow}`}
                title={workflow.title} icon={<Icon name="tree-structure" />} selected={selectedDefinitionId === workflow.workflow}
                onPress={() => router.push(`/workflows/${encodeURIComponent(workflow.workflow)}` as never)} />)}
        </> : null}
    </>;
});

/**
 * What a Library row says at its end (lab `nav-N1` column): the one amber mark while a run waits for you,
 * "Running" while one works, else how long ago it last ran. Runs themselves live in the Runs view (R-22).
 */
function readDefinitionLife(summary: WorkflowLibraryRunSummary | undefined):
    Readonly<{ kind: 'needsYou' | 'running' | 'quiet' }> | Readonly<{ kind: 'rested'; age: string }> {
    if (summary === undefined) return { kind: 'quiet' };
    if (summary.needsYouRunId !== null) return { kind: 'needsYou' };
    if (hasWorkingWorkflowLibraryRun(summary)) return { kind: 'running' };
    const createdAt = summary.lastRun === null ? Number.NaN : Date.parse(summary.lastRun.createdAt);
    return Number.isFinite(createdAt) ? { kind: 'rested', age: formatRelativeTimeShort(createdAt, Date.now()) } : { kind: 'quiet' };
}

/**
 * A library row's second line (lab `convo-N7`): what makes it run by itself ("Every night at 02:00 · 1 more"),
 * or why it cannot be read. A manual workflow is its name alone, so the index stays quiet.
 */
function definitionSubtitle(definition: WorkflowLibraryDefinition): string | null {
    if (definition.contentStatus === 'unavailable') return formatWorkflowDefinitionContentUnavailableReason(definition.contentUnavailableReason);
    return definition.triggers.length > 0 ? formatTriggerSetSummary(definition.triggers) : null;
}

/**
 * The column's Built-in group (07 S1, lab `convo-N7`): the same navigation row as Library, mark and name
 * only. Run now and Choose a session… stay on each built-in's page and on the library home, so the
 * column carries one row anatomy and never repeats the home's description.
 */
function ColumnBuiltins(props: Readonly<{ selectedDefinitionId: string | null; isVisible: (key: string) => boolean }>) {
    const router = useRouter();
    // Built-ins narrow with the space and search like every other row (R8-7); none left, no group.
    const entries = getBuiltinWorkflowCatalogV1().filter((entry) => props.isVisible(entry.id));
    if (entries.length === 0) return null;
    return <>
        <CollectionListGroupLabel testID="workflows-column:group:builtin" title={t('workflows.page.blocks.builtin')} countPlacement="title" count={entries.length} />
        {entries.map((entry) => {
            const href = createWorkflowDefinitionRoute(entry.id);
            return <CollectionNavigationRow key={entry.id} href={href} testID={`workflows-column:builtin:${entry.id}`}
                title={tLoose(entry.titleKey)} icon={<WorkflowPurposeGlyph purpose={entry.purpose} />} selected={props.selectedDefinitionId === entry.id}
                onPress={() => router.push(href as never)} />;
        })}
    </>;
}

const styles = StyleSheet.create((theme) => ({
    column: { flex: 1, minHeight: 0 },
    views: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingBottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop,
        flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    // As the destination's page (a phone), the switch sits on the page sheets' edge, not the column's row inset.
    viewsOnPage: { paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx },
    viewTabs: { flex: 1, minWidth: 0 },
    definitionsList: { backgroundColor: 'transparent' },
    // The switch's one place in both views: the band under the title, ending the row the spaces strip
    // leads (Definitions) or alone at the row's end (Runs). The title row's width never decides where it sits.
    viewBand: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
    viewBandLead: { flex: 1, minWidth: 0 },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    freshness: { paddingHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset, paddingBottom: HAPPIER_COLLECTION_LIST_METRICS.groupLabelFirstPaddingTop },
    // A column section's state is the one in-list state line, on the rows' content edge.
}));
