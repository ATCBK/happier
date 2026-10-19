import React from 'react';
import { Platform, View, type ViewToken } from 'react-native';
import { VirtualizedList } from '@/components/ui/lists/virtualized/VirtualizedList';
import type { VirtualizedListRef } from '@/components/ui/lists/virtualized/virtualizedListTypes';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { t, type TranslationKey } from '@/text';

import { SessionFolderFocusBreadcrumbs, SessionsListHeader } from './sessionListChrome';
import type { SessionFolderFocusScope } from '@/sync/domains/session/folders';
import type { SessionListRowViewModel } from './sessionListRowViewModels';
import { NewSessionDraftsSection } from './NewSessionDraftsSection';
import { SessionListViewEmptyState } from './SessionListViewEmptyState';
import type { SessionListQueryPresentation } from '@/sync/domains/session/listing/sessionListIndexPresentation';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListViewContext, SessionListViewFilters } from './search/sessionListViewFilters';

export type SessionListVirtualizedNode = Readonly<{
    id: string;
    kind: SessionListIndexItem['type'];
    headerKind?: Extract<SessionListIndexItem, { type: 'header' }>['headerKind'];
    rowViewModel?: SessionListRowViewModel | null;
    isGroupTail?: boolean;
}>;

type SessionListScrollEvent = Readonly<{
    nativeEvent?: Readonly<{
        contentOffset?: Readonly<{ y?: number }>;
    }>;
}>;

type SessionListLayoutEvent = Readonly<{
    nativeEvent?: Readonly<{
        layout?: Readonly<{ y?: number; height?: number }>;
    }>;
}>;

const WEB_LIST_SCROLL_EVENT_THROTTLE_MS = 32;
const NATIVE_LIST_SCROLL_EVENT_THROTTLE_MS = 16;
// Row taps must work while the session-search keyboard is open ('handled'), and a
// deliberate list drag dismisses it. Interactive dismissal is iOS-only behaviour.
const SESSION_LIST_KEYBOARD_DISMISS_MODE = Platform.OS === 'ios' ? 'interactive' : 'on-drag';

const sessionListNodeKeyExtractor = (item: SessionListVirtualizedNode): string => item.id;

const SessionListCompositeHeader = React.memo(function SessionListCompositeHeader(props: Readonly<{
    folderFocus: SessionFolderFocusScope | null;
    folderFocusRootTitle?: string | null;
    onClearFolderFocus: () => void;
    onSelectFolderBreadcrumb: (folderId: string) => void;
    rowDensity: SessionListRowDensity;
    showDrafts?: boolean;
    /** The Account's own reminders (Recovery key) belong to Sessions, not to a Runs-only list. */
    showReminders?: boolean;
    scheduledSection?: React.ReactNode;
    viewContext?: SessionListViewContext;
}>) {
    return (
        <>
            {props.showReminders !== false ? <SessionsListHeader /> : null}
            {props.scheduledSection}
            {props.showDrafts !== false ? (
                <NewSessionDraftsSection
                    density={props.rowDensity}
                    viewContext={props.viewContext}
                />
            ) : null}
            {props.folderFocus ? (
                <SessionFolderFocusBreadcrumbs
                    breadcrumbs={props.folderFocus.breadcrumbs}
                    onClear={props.onClearFolderFocus}
                    onSelectFolder={props.onSelectFolderBreadcrumb}
                    rootTitle={props.folderFocusRootTitle}
                />
            ) : null}
        </>
    );
});

export const SESSION_LIST_FILTERED_NO_RESULTS_MESSAGE_KEY = 'directSessions.browseNoSearchResults' satisfies TranslationKey;

/**
 * The ordinary (non-query) list narrowed by its header filters to nothing: the same one quiet line the
 * query states use, so a search that finds nothing says so instead of leaving bare group headers.
 */
export function SessionListFilteredNoResultsMessage(props: Readonly<{
    message?: TranslationKey;
}>) {
    return (
        <View accessibilityLiveRegion="polite" testID="session-list-filtered-no-results">
            <EmptyState
                layout="line"
                title={t(props.message ?? SESSION_LIST_FILTERED_NO_RESULTS_MESSAGE_KEY)}
            />
        </View>
    );
}

export type SessionListRowDensity = 'default' | 'compact' | 'minimal';

/**
 * Virtualized row types are keyed on this value. Session cell heights are
 * NOT uniform: last/single-in-group rows carry the inter-group bottom margin
 * (see SessionItem container styles) and density changes the base height, so
 * pooling all sessions under one type lets a recycled cell reuse a stale
 * height from a different group position — visible as a bottom gap/overlap
 * when sessions change groups. Keying the pool on the HEIGHT CLASS keeps
 * every pool height-homogeneous while avoiding remounts (a type change
 * remounts the cell, tearing down drag/context-menu state) for position
 * flips that do not change the cell height: 'tail' rows (last/single) carry
 * the inter-group gap, 'body' rows (first/middle) do not.
 */
function getSessionListNodeType(node: SessionListVirtualizedNode, rowDensity: SessionListRowDensity): string {
    if (node.kind === 'workflow_run') {
        return `workflow_run:${rowDensity}:${node.isGroupTail === true ? 'tail' : 'body'}`;
    }
    if (node.kind === 'session') {
        const heightClass = node.rowViewModel?.isLast === true || node.rowViewModel?.isSingle === true
            ? 'tail'
            : 'body';
        return `session:${rowDensity}:${heightClass}`;
    }
    if (node.kind === 'header' && node.headerKind) {
        return `header:${node.headerKind}`;
    }
    return 'header';
}

export const SessionListVirtualizedContent = React.memo(function SessionListVirtualizedContent(props: Readonly<{
    listRef?: React.Ref<VirtualizedListRef>;
    nodes: ReadonlyArray<SessionListVirtualizedNode>;
    rowDensity?: SessionListRowDensity;
    rowHeight: number;
    safeAreaBottom: number;
    renderItem: (params: { item: SessionListVirtualizedNode; index: number }) => React.ReactElement | null;
    rowExtraData: unknown;
    onScroll?: (event: SessionListScrollEvent) => void;
    onScrollBeginDrag?: () => void;
    onScrollEndDrag?: () => void;
    onMomentumScrollBegin?: () => void;
    onMomentumScrollEnd?: () => void;
    onEndReached?: () => void;
    nativeRefreshControl?: React.ReactElement;
    onViewableItemsChanged?: (info: { viewableItems: ViewToken[] }) => void;
    viewabilityConfig?: Readonly<{
        itemVisiblePercentThreshold?: number;
        minimumViewTime?: number;
        viewAreaCoveragePercentThreshold?: number;
        waitForInteraction?: boolean;
    }>;
    onLayout?: (event: SessionListLayoutEvent) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onStopScrollEventPropagationOnWeb: (event: any) => void;
    filteredNoResultsMessage?: TranslationKey;
    queryPresentationState?: Readonly<{
        presentation: SessionListQueryPresentation;
        visibleSessionCount: number;
        selectedHomeServerIds?: readonly string[];
        filters: SessionListViewFilters;
        defaults: SessionListViewFilters;
        viewContext: SessionListViewContext;
        includeInactive: boolean;
        hasHiddenInactiveSessions: boolean;
        onRetry: () => void;
        onLoadMore: () => void;
        onClearFilters: () => void;
        onBrowseAllAccessible: () => void;
        onShowInactive: () => void;
    }>;
    /** Qualified corpus context remains available even when no empty/query presentation is mounted. */
    viewContext?: SessionListViewContext;
    folderFocus: SessionFolderFocusScope | null;
    folderFocusRootTitle?: string | null;
    showDrafts?: boolean;
    showReminders?: boolean;
    /** The global, live Work sidebar alone demands Account upcoming work. */
    scheduledSection?: React.ReactNode;
    onClearFolderFocus: () => void;
    onSelectFolderBreadcrumb: (folderId: string) => void;
}>) {
    // The SessionsList viewport owns preferred page width versus a filled Run column.
    // Rows fill that viewport; a second cap here would silently narrow only their sheet.
    const contentContainerStyle = React.useMemo(() => ({
        paddingBottom: props.safeAreaBottom + 128,
    }), [props.safeAreaBottom]);
    // A FlatList rejects a new `onViewableItemsChanged` for its whole lifetime ("Changing
    // onViewableItemsChanged on the fly is not supported"), so the list gets one function per list
    // instance that forwards to the caller's current handler. It lives in a ref, not a `useCallback`:
    // Fast Refresh discards hook memo caches on every edit, and a new callback would crash the list.
    const onViewableItemsChangedRef = React.useRef(props.onViewableItemsChanged);
    onViewableItemsChangedRef.current = props.onViewableItemsChanged;
    const viewableItemsChangedForwarderRef = React.useRef<((info: { viewableItems: ViewToken[] }) => void) | null>(null);
    if (viewableItemsChangedForwarderRef.current === null) {
        viewableItemsChangedForwarderRef.current = (info) => {
            onViewableItemsChangedRef.current?.(info);
        };
    }
    const handleViewableItemsChanged = viewableItemsChangedForwarderRef.current;
    // Same lifetime rule for the config (compared deeply): keep the first one this list received.
    const viewabilityConfigRef = React.useRef(props.viewabilityConfig);
    const viewabilityConfig = viewabilityConfigRef.current;
    const rowDensity: SessionListRowDensity = props.rowDensity ?? 'default';
    // Archived is reached from the list title's scope menu, not from a card after the rows.
    const footerComponent = React.useMemo(() => (
        props.queryPresentationState ? (
            <SessionListViewEmptyState {...props.queryPresentationState} />
        ) : props.filteredNoResultsMessage ? (
            <SessionListFilteredNoResultsMessage message={props.filteredNoResultsMessage} />
        ) : null
    ), [props.filteredNoResultsMessage, props.queryPresentationState]);
    const headerComponent = React.useMemo(() => (
        <SessionListCompositeHeader
            folderFocus={props.folderFocus}
            folderFocusRootTitle={props.folderFocusRootTitle}
            onClearFolderFocus={props.onClearFolderFocus}
            onSelectFolderBreadcrumb={props.onSelectFolderBreadcrumb}
            rowDensity={rowDensity}
            showDrafts={props.showDrafts}
            showReminders={props.showReminders}
            scheduledSection={props.scheduledSection}
            viewContext={props.viewContext}
        />
    ), [props.folderFocus, props.folderFocusRootTitle, props.onClearFolderFocus, props.onSelectFolderBreadcrumb, props.showDrafts, props.showReminders, props.scheduledSection, props.viewContext, rowDensity]);
    const getNodeType = React.useCallback(
        (node: SessionListVirtualizedNode) => getSessionListNodeType(node, rowDensity),
        [rowDensity],
    );
    const isWeb = Platform.OS === 'web';
    return (
        <VirtualizedList
            ref={props.listRef as React.Ref<VirtualizedListRef>}
            data={props.nodes as any}
            renderItem={props.renderItem as any}
            extraData={props.rowExtraData}
            keyExtractor={sessionListNodeKeyExtractor}
            getItemType={getNodeType as any}
            contentContainerStyle={contentContainerStyle as any}
            onScroll={props.onScroll}
            onScrollBeginDrag={props.onScrollBeginDrag}
            onScrollEndDrag={props.onScrollEndDrag}
            onMomentumScrollBegin={props.onMomentumScrollBegin}
            onMomentumScrollEnd={props.onMomentumScrollEnd}
            onEndReached={props.onEndReached}
            onEndReachedThreshold={0.4}
            maintainVisibleContentPosition={false}
            refreshControl={isWeb ? undefined : props.nativeRefreshControl}
            webScrollHandlers={isWeb
                ? ({
                    onWheel: props.onStopScrollEventPropagationOnWeb,
                    onTouchMove: props.onStopScrollEventPropagationOnWeb,
                })
                : undefined}
            onViewableItemsChanged={handleViewableItemsChanged as any}
            viewabilityConfig={viewabilityConfig as any}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            scrollEventThrottle={isWeb ? WEB_LIST_SCROLL_EVENT_THROTTLE_MS : NATIVE_LIST_SCROLL_EVENT_THROTTLE_MS}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={SESSION_LIST_KEYBOARD_DISMISS_MODE}
            ListHeaderComponent={headerComponent as any}
            ListFooterComponent={footerComponent as any}
            // Session rows carry drag state, images, menus, and focus. Keep
            // recycling off until those local-state seams have been audited.
            recycleItems={false}
        />
    );
});
