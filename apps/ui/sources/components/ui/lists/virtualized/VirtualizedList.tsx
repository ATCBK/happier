import * as React from 'react';

import { LegendListBackend } from './backends/legendListBackend';
import type {
    VirtualizedListProps,
    VirtualizedListRef,
} from './virtualizedListTypes';

/**
 * Canonical Happier virtualized list on every platform. Product surfaces import
 * this and never name the list library; the imperative handle is the stable
 * {@link VirtualizedListRef}. Legend derives row positions from measured sizes;
 * React Native's FlatList caches per-cell offsets that go stale on web when
 * content above a cell changes without resizing it, so it is not offered.
 */
function VirtualizedListInner<T>(
    props: VirtualizedListProps<T>,
    ref: React.ForwardedRef<VirtualizedListRef>,
): React.ReactElement {
    return <LegendListBackend {...props} ref={ref} />;
}

export const VirtualizedList = React.forwardRef(VirtualizedListInner) as <T>(
    props: VirtualizedListProps<T> & { ref?: React.Ref<VirtualizedListRef> },
) => React.ReactElement;
