import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { UsageAnalyticsViewModel, UsageFilterState } from '@/sync/api/account/usageAnalytics';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { buildUsageRecapCardModels } from '@/sync/domains/usage/recap/buildUsageRecapCardModels';
import { formatIdentifierLabel } from '@/utils/format/usageNumbers';

/**
 * The period's highlights (lab `urecap` "Highlights"): one quiet row per produced fact — its name,
 * the fact in strong text and what it rests on. No card chrome, no per-fact share: the composer
 * behind Share is the one place a recap leaves the device.
 */
export function UsageRecapHighlights(props: Readonly<{
    viewModel: UsageAnalyticsViewModel;
    filters: UsageFilterState;
    query?: UsageQuery;
    testID: string;
}>): React.ReactElement | null {
    const highlights = React.useMemo(() => buildUsageRecapCardModels({
        viewModel: props.viewModel,
        filters: props.filters,
        query: props.query,
    }), [props.viewModel, props.filters, props.query]);
    if (highlights.length === 0) return null;
    return (
        <View testID={props.testID} style={styles.grid} accessibilityRole="list">
            {highlights.map((highlight) => (
                <View key={highlight.id} testID={highlight.testID} style={styles.item} accessibilityRole="text"
                    accessibilityLabel={`${highlight.label}: ${formatIdentifierLabel(highlight.value)}, ${highlight.subtitle}`}>
                    <View style={styles.text}>
                        <Text style={styles.label} numberOfLines={1}>{highlight.label}</Text>
                        <Text style={styles.value} numberOfLines={1}>{formatIdentifierLabel(highlight.value)}</Text>
                        <Text style={styles.detail} numberOfLines={2}>{highlight.subtitle}</Text>
                    </View>
                </View>
            ))}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: theme.space.s24,
        rowGap: theme.space.s4,
    },
    item: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s10,
        flexGrow: 1,
        flexBasis: 200,
        minWidth: 0,
        paddingTop: theme.space.s12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    text: { flex: 1, minWidth: 0, gap: theme.space.s2 },
    // The fact leads; its name is the quiet line above it (lab urecap Highlights).
    label: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
    },
    value: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    detail: {
        ...Typography.variant('body'),
        color: theme.colors.text.tertiary,
    },
}));
