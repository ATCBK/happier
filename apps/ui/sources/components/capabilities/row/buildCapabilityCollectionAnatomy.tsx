import * as React from 'react';
import type { CollectionAnatomy } from '@happier-dev/plugin-ui/components';

import { CapabilityFacts, type CapabilityFactsProps } from '@/components/capabilities/facts/CapabilityFacts';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import { presentCapabilityStatus, type CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { Text } from '@/components/ui/text/Text';
import { StyleSheet } from 'react-native-unistyles';

/**
 * The capability row anatomy for the public `Collection` (add modal list, homepage shelf): name with the
 * where-summary at the title line's end (never truncated), description, then the facts line, which a non-silent
 * status takes. Kinds without a mark (skills) draw no glyph column.
 */
export function buildCapabilityCollectionAnatomy<Item>(input: Readonly<{
    title: (item: Item) => string;
    description: (item: Item) => string | null;
    whereSummary?: (item: Item) => React.ReactNode;
    facts: (item: Item) => CapabilityFactsProps;
    status?: (item: Item) => CapabilityStatus | null;
    mark?: (item: Item) => React.ReactNode;
    action?: (item: Item) => React.ReactNode;
    accessibilityLabel: (item: Item) => string;
    testID: (item: Item) => string;
}>): CollectionAnatomy<Item> {
    const speakingStatus = (item: Item): CapabilityStatus | null => {
        const status = input.status?.(item) ?? null;
        return status !== null && presentCapabilityStatus(status, 'row').pill !== null ? status : null;
    };
    return {
        glyph: (item) => input.mark?.(item) ?? null,
        title: input.title,
        description: input.description,
        ...(input.whereSummary === undefined ? {} : {
            titleMeta: (item: Item) => {
                const summary = input.whereSummary!(item);
                return typeof summary === 'string' ? <Text variant="meta" numberOfLines={1} style={styles.summary}>{summary}</Text> : summary;
            },
        }),
        byline: (item) => <CapabilityFacts {...input.facts(item)} />,
        reason: (item) => {
            const status = speakingStatus(item);
            return status === null ? null : <CapabilityStatusChip status={status} testID={`${input.testID(item)}:status`} />;
        },
        ...(input.action === undefined ? {} : { action: input.action }),
        accessibilityLabel: input.accessibilityLabel,
        testID: input.testID,
        columnTitles: { title: '' },
    };
}

const styles = StyleSheet.create((theme) => ({
    summary: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
}));
