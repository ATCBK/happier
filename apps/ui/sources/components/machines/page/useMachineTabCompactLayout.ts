import * as React from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';

/** Below this width a tab body recomposes for a phone (lab `*p` frames): figures over bars, no side panels. */
export const MACHINE_TAB_COMPACT_WIDTH = 640;

/** A tab body's own width decides its phone layout, so a narrow desktop pane reads like a phone too. */
export function useMachineTabCompactLayout(): Readonly<{ compact: boolean; onLayout: (event: LayoutChangeEvent) => void; measured: boolean }> {
    const [width, setWidth] = React.useState<number | null>(null);
    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const visibleWidth = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
        if (visibleWidth === null) return;
        const next = Math.round(visibleWidth);
        setWidth(previous => previous === next ? previous : next);
    }, []);
    return { compact: width !== null && width < MACHINE_TAB_COMPACT_WIDTH, onLayout, measured: width !== null };
}
