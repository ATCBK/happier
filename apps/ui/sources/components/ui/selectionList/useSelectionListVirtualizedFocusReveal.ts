import * as React from 'react';

import type {
    VirtualizedListProps,
    VirtualizedListRef,
} from '@/components/ui/lists/virtualized/virtualizedListTypes';

type ViewportSize = Readonly<{ width: number; height: number }>;

/**
 * Keeps the focused virtual row visible when focus moves to another row or the viewport changes size.
 * Keyboard and layout changes can shrink the recycler without changing the focused option, so the
 * viewport is a reveal trigger too. A live data update that only moves rows (a machine changes state
 * and re-sorts) is not: the reader stays where they are instead of jumping back to the focused row.
 */
export function useSelectionListVirtualizedFocusReveal(args: Readonly<{
    listRef: React.RefObject<VirtualizedListRef | null>;
    focusedItemIndex: number;
    /** The focused row's identity; a reveal follows a change of identity, not of index. */
    focusedKey: string | null;
    reducedMotion: boolean;
}>): Readonly<{
    onViewportLayout: NonNullable<VirtualizedListProps<unknown>['onLayout']>;
}> {
    const focusedItemIndexRef = React.useRef(args.focusedItemIndex);
    focusedItemIndexRef.current = args.focusedItemIndex;
    const revealFocusedItem = React.useCallback(() => {
        const index = focusedItemIndexRef.current;
        if (index < 0) return;
        const ref = args.listRef.current;
        if (!ref || typeof ref.scrollToIndex !== 'function') return;
        ref.scrollToIndex({
            index,
            viewPosition: 0.5,
            animated: !args.reducedMotion,
        });
    }, [args.listRef, args.reducedMotion]);

    const revealedKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (args.focusedKey === null || args.focusedItemIndex < 0) {
            // Nothing focused here (or the row is not in this list): the next focus reveals.
            revealedKeyRef.current = null;
            return;
        }
        if (revealedKeyRef.current === args.focusedKey) return;
        revealedKeyRef.current = args.focusedKey;
        revealFocusedItem();
    }, [args.focusedKey, args.focusedItemIndex, revealFocusedItem]);

    const previousViewportSizeRef = React.useRef<ViewportSize | null>(null);
    const onViewportLayout = React.useCallback<NonNullable<VirtualizedListProps<unknown>['onLayout']>>(
        (event) => {
            const { width, height } = event.nativeEvent.layout;
            const previous = previousViewportSizeRef.current;
            previousViewportSizeRef.current = { width, height };
            if (previous === null) return;
            if (previous.width === width && previous.height === height) return;
            revealFocusedItem();
        },
        [revealFocusedItem],
    );

    return { onViewportLayout };
}
