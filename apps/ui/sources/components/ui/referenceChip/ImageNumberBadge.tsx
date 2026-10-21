import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * A picture's "Image #N" number on its corner (lab TA): the composer tray and the transcript's
 * numbered pictures draw the same badge, so a chip and its picture pair at a glance.
 */
export function ImageNumberBadge(props: Readonly<{ number: number; testID?: string }>) {
    return (
        <View pointerEvents="none" style={styles.badge} testID={props.testID}>
            <Text style={styles.text}>{props.number}</Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    badge: {
        position: 'absolute',
        top: 4,
        left: 4,
        minWidth: 18,
        height: 18,
        paddingHorizontal: 5,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.overlay.scrim,
    },
    text: {
        color: theme.colors.overlay.foreground,
        ...Typography.variant('micro', 'semiBold'),
        fontVariant: ['tabular-nums'],
    },
}));
