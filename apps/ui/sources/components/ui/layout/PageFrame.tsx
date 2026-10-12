import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { useLayoutMaxWidth } from './layout';
import type { PageColumn } from './contentWidthMode';
import { PageColumnProvider } from '@/components/ui/lists/listPresentation';

export type PageFrameProps = Readonly<{
    children?: React.ReactNode;
    column?: PageColumn | 'conversation';
    /** Sections own their header/gutters/gaps; free content gets the page anatomy here. */
    content?: 'free' | 'sections' | 'column';
    underNativeChrome?: boolean;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;

/** One frame for pages and the existing constrained-column adapters. */
export const PageFrame = React.memo(function PageFrame(props: PageFrameProps) {
    const content = props.content ?? 'free';
    const column = props.column ?? (content === 'column' ? undefined : 'reading');
    const maxWidth = useLayoutMaxWidth(column);
    const frame = (
        <View
            testID={props.testID}
            style={[
                { width: '100%', alignSelf: 'center' },
                // A section header measures the whole pane before placing Back in its gutter.
                // The sections cap their inner content through the same named-column context.
                content === 'sections' ? null : { maxWidth },
                content === 'free' ? {
                    paddingHorizontal: HAPPIER_PAGE_METRICS.sheetInsetPx,
                    paddingTop: props.underNativeChrome
                        ? HAPPIER_PAGE_METRICS.pageHeaderUnderChromePaddingTopPx
                        : HAPPIER_PAGE_METRICS.pageHeaderPaddingTopPx,
                    gap: HAPPIER_PAGE_METRICS.sectionGapPx,
                } : null,
                content === 'column' ? null : { paddingBottom: HAPPIER_PAGE_METRICS.pagePaddingBottomPx },
                props.style,
            ]}
        >
            {props.children}
        </View>
    );
    return column && column !== 'conversation'
        ? <PageColumnProvider value={column}>{frame}</PageColumnProvider>
        : frame;
});
