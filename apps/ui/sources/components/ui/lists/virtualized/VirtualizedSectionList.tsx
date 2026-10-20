import * as React from 'react';
import {
    SectionList as LegendSectionList,
    type SectionListProps as LegendSectionListProps,
    type SectionListRef as LegendSectionListRef,
} from '@legendapp/list/section-list';

import type {
    VirtualizedSectionListProps,
    VirtualizedSectionListRef,
} from './virtualizedListTypes';

/**
 * Canonical section list on every platform, backed by Legend. The imperative
 * handle is the stable {@link VirtualizedSectionListRef}.
 */
function VirtualizedSectionListInner<T>(
    props: VirtualizedSectionListProps<T>,
    ref: React.ForwardedRef<VirtualizedSectionListRef>,
): React.ReactElement {
    const legendRef = React.useRef<LegendSectionListRef | null>(null);

    React.useImperativeHandle(ref, (): VirtualizedSectionListRef => ({
        scrollToIndex: (params) => legendRef.current?.scrollToIndex(params),
        scrollToOffset: (params) => legendRef.current?.scrollToOffset(params),
        scrollToEnd: (params) => legendRef.current?.scrollToEnd(params),
        scrollToLocation: (params) => legendRef.current?.scrollToLocation(params),
        getScrollableNode: () => legendRef.current?.getScrollableNode(),
        getNativeScrollRef: () => legendRef.current?.getNativeScrollRef(),
        clearMeasurementCache: (options) => legendRef.current?.clearCaches(options),
        getState: () => legendRef.current?.getState(),
    }), []);

    const commonProps = {
        sections: props.sections,
        keyExtractor: props.keyExtractor,
        renderItem: props.renderItem,
        renderSectionHeader: props.renderSectionHeader,
        renderSectionFooter: props.renderSectionFooter,
        testID: props.testID,
        nativeID: props.nativeID,
        style: props.style,
        contentContainerStyle: props.contentContainerStyle,
        ListHeaderComponent: props.ListHeaderComponent,
        ListFooterComponent: props.ListFooterComponent,
        ListEmptyComponent: props.ListEmptyComponent,
        ItemSeparatorComponent: props.ItemSeparatorComponent,
        stickySectionHeadersEnabled: props.stickySectionHeadersEnabled,
        showsVerticalScrollIndicator: props.showsVerticalScrollIndicator,
        scrollEventThrottle: props.scrollEventThrottle,
        onScroll: props.onScroll,
        onLayout: props.onLayout,
        onContentSizeChange: props.onContentSizeChange,
        onEndReached: props.onEndReached,
        onEndReachedThreshold: props.onEndReachedThreshold,
        onViewableItemsChanged: props.onViewableItemsChanged,
        viewabilityConfig: props.viewabilityConfig,
        refreshing: props.refreshing,
        onRefresh: props.onRefresh,
        refreshControl: props.refreshControl,
        keyboardShouldPersistTaps: props.keyboardShouldPersistTaps,
        keyboardDismissMode: props.keyboardDismissMode,
    };

    // Boundary adapter: Legend's section shapes are structural supersets of
    // the neutral contract.
    const legendProps = {
        ...commonProps,
        ...props.webScrollHandlers,
        estimatedItemSize: props.estimatedItemSize,
        recycleItems: props.recycleItems,
    } as unknown as LegendSectionListProps<T>;
    return <LegendSectionList {...legendProps} ref={legendRef} />;
}

export const VirtualizedSectionList = React.forwardRef(VirtualizedSectionListInner) as <T>(
    props: VirtualizedSectionListProps<T> & { ref?: React.Ref<VirtualizedSectionListRef> },
) => React.ReactElement;
