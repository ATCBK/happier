import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** Narrowest a plugin card may become before the Plugins grid drops a column. */
export const PLUGIN_CARD_MIN_WIDTH_PX = 240;

/**
 * A plugin's state on its card or row (the Collection's `reason` slot): quiet by default, with a dot only when it
 * needs the reader.
 */
export function PluginCardStatus(props: Readonly<{
    label: string;
    tone: 'quiet' | 'warning' | 'danger';
    testID?: string;
}>) {
    const styles = stylesheet;
    return (
        <View style={styles.statusRow} testID={props.testID}>
            {props.tone === 'quiet' ? null : (
                <View
                    testID={props.testID ? `${props.testID}:dot` : undefined}
                    style={[styles.statusDot, props.tone === 'danger' ? styles.statusDotDanger : styles.statusDotWarning]}
                />
            )}
            <Text
                style={[
                    styles.status,
                    props.tone === 'warning' ? styles.statusWarning : null,
                    props.tone === 'danger' ? styles.statusDanger : null,
                ]}
                numberOfLines={1}
            >
                {props.label}
            </Text>
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
    },
    statusDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    statusDotWarning: {
        backgroundColor: theme.colors.state.warning.foreground,
    },
    statusDotDanger: {
        backgroundColor: theme.colors.state.danger.foreground,
    },
    status: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
    },
    statusWarning: {
        color: theme.colors.state.warning.foreground,
    },
    statusDanger: {
        color: theme.colors.state.danger.foreground,
    },
}));
