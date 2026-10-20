import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { DocumentTabStrip, type DocumentTabPresentation, type DocumentTabStripTestIds } from '@/components/ui/navigation/DocumentTabStrip';
import { FileIcon } from '@/components/ui/media/FileIcon';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import type { DetailsTabState, DetailsWorkspaceGroupView } from './detailsWorkspaceTypes';
import { hrefForDestinationRef, useDestinationInstanceTitles } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { buildActiveDetailsRouteParams } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { runGuardedTabNavigation } from '@/utils/navigation/runGuardedNavigation';

export type DetailsTabStripTestIds = DocumentTabStripTestIds;
export type DetailsTabPresentation = DocumentTabPresentation;
export type DetailsTabStripProps = Readonly<{
    sessionId?: string;
    serverId?: string | null;
    resolveTabHref?: (tab: DetailsTabState) => string | null;
    pane: Pick<AppPaneScopeApi, 'setActiveDetailsTab' | 'pinDetailsTab' | 'unpinDetailsTab' | 'closeDetailsTab'>;
    group: DetailsWorkspaceGroupView;
    resolveTabIconName?: ((tab: DetailsTabState) => string | null | undefined) | null;
    resolveTabPresentation?: ((tab: DetailsTabState) => DetailsTabPresentation | null | undefined) | null;
    unsavedTabKeys?: ReadonlySet<string>;
    testIds?: DetailsTabStripTestIds;
}>;

export function detailsTabNativeId(groupId: string, tabKey: string): string {
    return `details-${toTestIdSafeValue(groupId)}-tab-${toTestIdSafeValue(tabKey)}`;
}

export function detailsTabPanelNativeId(groupId: string, tabKey: string): string {
    return `details-${toTestIdSafeValue(groupId)}-panel-${toTestIdSafeValue(tabKey)}`;
}

/** Details owns resource semantics; DocumentTabStrip owns the shared document chrome. */
export const DetailsTabStrip = React.memo((props: DetailsTabStripProps) => {
    const { theme } = useUnistyles();
    const closeTab = React.useCallback((tabKey: string) => {
        void runGuardedTabNavigation([tabKey], () => props.pane.closeDetailsTab(tabKey));
    }, [props.pane.closeDetailsTab]);
    const entries = React.useMemo(() => props.sessionId ? props.group.tabs.map(tab => ({ key: tab.key, fallbackTitle: tab.title, ref: {
        kind: tab.kind === 'session' ? 'session' : 'sessionDetails',
        params: { id: props.sessionId!, ...(props.serverId ? { serverId: props.serverId } : {}), ...buildActiveDetailsRouteParams([tab], tab.key) },
    } })) : [], [props.group.tabs, props.serverId, props.sessionId]);
    const titles = useDestinationInstanceTitles(EMPTY_CATALOG, entries);
    const hrefs = React.useMemo(() => props.resolveTabHref
        ? new Map(props.group.tabs.map(tab => [tab.key, props.resolveTabHref!(tab)]))
        : new Map(entries.map(entry => [entry.key, hrefForDestinationRef(EMPTY_CATALOG, entry.ref)])),
    [entries, props.group.tabs, props.resolveTabHref]);
    const tabs = React.useMemo(() => props.group.tabs.map(tab => {
        const title = titles.get(tab.key);
        return title && title !== tab.title ? { ...tab, title } : tab;
    }), [props.group.tabs, titles]);
    return <DocumentTabStrip
        tabs={tabs}
        activeTabKey={props.group.activeTabKey}
        accessibilityLabel={t('common.details')}
        onActivate={props.pane.setActiveDetailsTab}
        onPin={props.pane.pinDetailsTab}
        onUnpin={props.pane.unpinDetailsTab}
        onClose={closeTab}
        resolveTabPresentation={props.resolveTabPresentation}
        unsavedTabKeys={props.unsavedTabKeys}
        testIds={props.testIds}
        tabNativeId={(key) => detailsTabNativeId(props.group.id, key)}
        panelNativeId={(key) => detailsTabPanelNativeId(props.group.id, key)}
        renderLeadingIcon={(tab, active) => {
            if (tab.kind === 'file') return <FileIcon fileName={tab.title} size={M.tabGlyphPx}
                testID={`session-details-tab-file-icon-${toTestIdSafeValue(tab.key)}`} />;
            const iconName = props.resolveTabIconName?.(tab) ?? ({
                commit: 'git-commit', scmReview: 'diff', scmStash: 'archive',
                scmPullRequest: 'git-pull-request', terminal: 'terminal', executionRunLauncher: 'play',
            }[tab.kind] ?? 'circle');
            return <Icon name={iconName as IconName} size={M.tabGlyphPx}
                color={active ? theme.colors.text.primary : theme.colors.text.secondary} />;
        }}
        wrapTab={(tab, content) => <WorkspaceDestinationRow href={hrefs.get(tab.key) ?? null} middleClickBehavior="passthrough"
            onOpened={() => closeTab(tab.key)}>{content}</WorkspaceDestinationRow>}
    />;
});

const EMPTY_CATALOG = Object.freeze([]);
