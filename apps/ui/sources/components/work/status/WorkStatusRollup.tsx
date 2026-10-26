import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { CollectionGroupRollup } from '@happier-dev/plugin-ui/presentation';

import { Text } from '@/components/ui/text/Text';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { workStatusWordStyle } from '@/components/work/status/workStatusTreatment';
import { t } from '@/text';

/**
 * A collapsed group's roll-up (lab `clgroups`): the strongest state among its folded rows, in the row status
 * slot's glyph column, with a word only when a person is needed ("3 need you", "Failed"). The membership
 * owner decides the state and count before the group folds; this draws, it never decides. Unknown coverage
 * stays silent rather than reading as calm.
 */
export const WorkStatusRollup = React.memo(function WorkStatusRollup(props: Readonly<{
    rollup: CollectionGroupRollup | undefined;
    testID: string;
}>) {
    const rollup = props.rollup;
    const status = rollup?.status;
    if (!rollup || !status || rollup.coverage === 'unavailable' || !status.glyph) return null;
    const count = rollup.needsYouCount;
    const word = status.bucket === 'needs_you' && count !== null && count > 1
        ? t('sessionWork.strip.needsYou', { count })
        : status.tone === 'danger' ? status.word : null;
    return (
        <View testID={props.testID} accessible accessibilityLabel={word ?? status.word} style={styles.slot}>
            {word ? (
                <Text variant="meta" emphasis="medium" numberOfLines={1} style={[styles.word, workStatusWordStyle(status.tone)]}>
                    {word}
                </Text>
            ) : null}
            <WorkStatusGlyph status={status} testIDSuffix={`${props.testID}-glyph`} />
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    slot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        flexShrink: 1,
        minWidth: 0,
    },
    word: {
        fontVariant: ['tabular-nums'],
        flexShrink: 1,
    },
}));
