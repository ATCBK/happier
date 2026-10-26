import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    formatProviderReasoningEffortLevelLabel,
    PROVIDER_REASONING_EFFORT_LEVELS_V1,
    type ProviderReasoningEffortLevelV1,
} from '@happier-dev/protocol/providers/catalog/reasoningEffort';

import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** The tiers in the Protocol's own order, so a declaration reads the same wherever it is edited. */
export function toggleProviderReasoningEffortLevel(
    levels: readonly ProviderReasoningEffortLevelV1[],
    level: ProviderReasoningEffortLevelV1,
): ProviderReasoningEffortLevelV1[] {
    const next = new Set(levels);
    if (!next.delete(level)) next.add(level);
    return PROVIDER_REASONING_EFFORT_LEVELS_V1.filter(candidate => next.has(candidate));
}

/** One on/off chip per tier the Protocol defines; none on means the model declares no tiers. */
export function ProviderReasoningEffortChips(props: Readonly<{
    levels: readonly ProviderReasoningEffortLevelV1[];
    onChange: (levels: ProviderReasoningEffortLevelV1[]) => void;
    disabled?: boolean;
    testID: string;
}>): React.ReactElement {
    return (
        <View
            role="group"
            accessibilityLabel={t('settingsProviders.models.reasoningEffort')}
            style={styles.chips}
        >
            {PROVIDER_REASONING_EFFORT_LEVELS_V1.map(level => (
                <SelectionListFilterChip
                    key={level}
                    filter={{
                        id: level,
                        testID: `${props.testID}.${level}`,
                        label: t('settingsProviders.models.reasoningEffort'),
                        valueLabel: formatProviderReasoningEffortLevelLabel(level),
                        selected: props.levels.includes(level),
                        disabled: props.disabled,
                        onToggle: () => props.onChange(toggleProviderReasoningEffortLevel(props.levels, level)),
                    }}
                />
            ))}
        </View>
    );
}

/** The optional "Reasoning effort" choice beneath a manual-model form: its name, what it does, the tiers. */
export function ProviderReasoningEffortField(props: Readonly<{
    levels: readonly ProviderReasoningEffortLevelV1[];
    onChange: (levels: ProviderReasoningEffortLevelV1[]) => void;
    disabled?: boolean;
    testID: string;
}>): React.ReactElement {
    return (
        <View style={styles.field}>
            <Text style={styles.label}>{t('settingsProviders.models.reasoningEffort')}</Text>
            <Text style={styles.description}>{t('settingsProviders.models.reasoningEffortDescription')}</Text>
            <ProviderReasoningEffortChips {...props} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    field: {
        marginTop: theme.space.s16,
        gap: theme.space.s4,
    },
    label: {
        ...Typography.variant('body', 'medium'),
        color: theme.colors.text.primary,
    },
    description: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        marginBottom: theme.space.s8,
    },
    chips: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.space.s8,
        alignItems: 'center',
    },
}));
