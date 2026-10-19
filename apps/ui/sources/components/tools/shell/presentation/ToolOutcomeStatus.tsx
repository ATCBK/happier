import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';

/**
 * The one terminal-outcome mark of a tool call: a glyph and a word, in the failure rose or, for a
 * refusal or a blocked call, the quiet ink. The row, the collapsed preview row and the group header
 * all render it, so one outcome reads the same word in the same type everywhere.
 */
export const ToolOutcomeStatus = React.memo(function ToolOutcomeStatus(props: Readonly<{
    testID: string;
    label: string;
    glyph: 'warning-circle' | 'minus-circle';
    /** `quiet` for a refusal: the product saying no is not a break. */
    tone: 'danger' | 'quiet';
}>) {
    const { theme } = useUnistyles();
    const quiet = props.tone === 'quiet';
    return (
        <View testID={props.testID} accessible={true} accessibilityLabel={props.label} style={styles.container}>
            <Icon
                name={props.glyph}
                size={ICON_SIZE.sm}
                color={quiet ? theme.colors.text.secondary : workStatusGlyphColor(theme.colors, 'danger')}
            />
            <Text style={[styles.text, quiet ? styles.textQuiet : null]} numberOfLines={1}>{props.label}</Text>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: theme.space.s6,
        minWidth: 0,
        maxWidth: 220,
    },
    text: {
        color: theme.colors.state.danger.foreground,
        ...Typography.variant('meta', 'semiBold'),
        flexShrink: 1,
    },
    textQuiet: {
        color: theme.colors.text.secondary,
    },
}));
