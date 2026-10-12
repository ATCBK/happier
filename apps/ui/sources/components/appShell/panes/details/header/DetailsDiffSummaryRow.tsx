import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { DETAILS_TAB_HEADER_METRICS } from './detailsTabHeaderMetrics';

/**
 * The one line between a Details header and a stream of file diffs (details lab 2, `dl-sum`):
 * how much changed, then the quiet controls for the stream (split, wrap) or a quiet operation
 * (Revert…). The files follow, each with its own header.
 */
export function DetailsDiffSummaryRow(props: Readonly<{
    /** Already-translated count ("4 files changed"). */
    label: string;
    added: number;
    removed: number;
    trailing?: React.ReactNode;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const metrics = DETAILS_TAB_HEADER_METRICS.pane;
    return (
        <View testID={props.testID} style={[stylesheet.row, { paddingLeft: metrics.paddingStartPx, paddingRight: metrics.paddingEndPx }]}>
            <Text style={stylesheet.label}>{props.label}</Text>
            {props.added > 0 ? (
                <Text style={[stylesheet.count, { color: theme.colors.diff.success }]}>{`+${props.added}`}</Text>
            ) : null}
            {props.removed > 0 ? (
                <Text style={[stylesheet.count, { color: theme.colors.diff.error }]}>{`−${props.removed}`}</Text>
            ) : null}
            <View style={stylesheet.grow} />
            {props.trailing}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minHeight: 40,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
    label: {
        ...Typography.default('semiBold'),
        ...DETAILS_TAB_HEADER_METRICS.pane.meta,
        color: theme.colors.text.secondary,
    },
    count: {
        ...Typography.default(),
        ...DETAILS_TAB_HEADER_METRICS.pane.meta,
        fontVariant: ['tabular-nums'],
    },
    grow: {
        flex: 1,
    },
}));
