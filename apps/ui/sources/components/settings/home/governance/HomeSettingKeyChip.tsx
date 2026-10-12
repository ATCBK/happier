import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The one presentation of an environment key on the Home console: a small monospace chip, inline
 * in a row's facts line. The deployment-fixed note and the Server settings facts line both render
 * keys through it, so a key never reads as prose and never wraps mid-name.
 */
export function HomeSettingKeyChip(props: Readonly<{ envKey: string; testID?: string }>) {
    return <Text testID={props.testID} style={styles.key}>{props.envKey}</Text>;
}

export type HomeSettingFactSegment = string | Readonly<{ envKey: string }>;

/**
 * A row's facts on one line ("0–65535 · `METRICS_PORT` · Default: 9090"), separated by " · ",
 * wrapping to a second line rather than hiding the default behind an ellipsis (a phone, or a row
 * whose control takes half the width). Keys render as chips.
 */
export function HomeSettingFactsLine(props: Readonly<{ segments: readonly HomeSettingFactSegment[]; testID: string }>) {
    if (props.segments.length === 0) return null;
    return (
        <Text testID={props.testID} style={styles.line} numberOfLines={2}>
            {props.segments.map((segment, index) => (
                <React.Fragment key={index}>
                    {index > 0 ? ' · ' : null}
                    {typeof segment === 'string'
                        ? segment
                        : <HomeSettingKeyChip envKey={segment.envKey} testID={`${props.testID}-key`} />}
                </React.Fragment>
            ))}
        </Text>
    );
}

const styles = StyleSheet.create((theme) => ({
    line: {
        flexShrink: 1,
        ...Typography.default('regular'),
        ...ITEM_SUBTITLE_TEXT_METRICS.comfortable,
        color: theme.colors.text.secondary,
    },
    key: {
        ...Typography.mono(),
        fontSize: 11.5,
        color: theme.colors.text.secondary,
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 4,
        paddingHorizontal: theme.space.s4,
        paddingVertical: 1,
    },
}));
