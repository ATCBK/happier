import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

/** The slot's square side: a page header's mark, and a row's. */
export const PAGE_HEADER_MARK_SLOT_SIZE_PX = Object.freeze({ page: HAPPIER_PAGE_METRICS.pageHeaderMarkSlotPx, row: 36 } as const);

/** Bare entity artwork, with stable page/row space and no backing or clipping. */
export function PageHeaderMarkSlot(props: Readonly<{
    children: React.ReactNode;
    testID?: string;
    size?: 'page' | 'row';
}>) {
    return (
        <View testID={props.testID} style={[stylesheet.markSlot, props.size === 'row' ? stylesheet.markSlotRow : null]}>
            {props.children}
        </View>
    );
}

const stylesheet = StyleSheet.create({
    markSlot: {
        width: PAGE_HEADER_MARK_SLOT_SIZE_PX.page,
        height: PAGE_HEADER_MARK_SLOT_SIZE_PX.page,
        alignItems: 'center',
        justifyContent: 'center',
    },
    markSlotRow: {
        width: PAGE_HEADER_MARK_SLOT_SIZE_PX.row,
        height: PAGE_HEADER_MARK_SLOT_SIZE_PX.row,
    },
});
