import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { MachineSummaryMetric, MachineSummaryStyle } from './machineSummaryStripModel';

const CAPTION_KEYS = {
    cpu: 'machineSummary.caption.cpu',
    memory: 'machineSummary.caption.memory',
    disk: 'machineSummary.caption.disk',
    network: 'machineSummary.caption.network',
} as const satisfies Record<MachineSummaryMetric, string>;

/** "CPU · memory free · disk free · last 5 min": the strip's one legend, so rows carry no labels (R7). */
export function describeMachineSummaryCaption(metrics: readonly MachineSummaryMetric[], style: MachineSummaryStyle): string | null {
    if (metrics.length === 0) return null;
    const words = metrics.map(metric => t(CAPTION_KEYS[metric]));
    // Only lines show a window of time.
    if (style === 'sparklines') words.push(t('machineSummary.caption.window'));
    return words.join(' · ');
}

export const MachineSummaryCaption = React.memo(function MachineSummaryCaption(props: Readonly<{
    metrics: readonly MachineSummaryMetric[];
    style: MachineSummaryStyle;
}>) {
    const caption = describeMachineSummaryCaption(props.metrics, props.style);
    if (!caption) return null;
    return <Text testID="machines.summary.caption" numberOfLines={1} style={stylesheet.caption}>{caption}</Text>;
});

const stylesheet = StyleSheet.create((theme) => ({
    caption: {
        ...Typography.timestamp(),
        color: theme.colors.text.tertiary,
    },
}));
