import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';

export const JumpToBottomButton = React.memo(function JumpToBottomButton(props: {
    count: number;
    onPress: () => void;
    presentation?: 'standard' | 'activity';
    testID?: string;
}) {
    const { theme, rt } = useUnistyles();
    const label = t('settingsSession.transcript.jumpToBottomButtonLabel');
    const accessibilityLabel = props.count > 0
        ? t('settingsSession.transcript.jumpToBottomButtonNewActivityLabel', { count: props.count })
        : label;
    const compact = props.presentation === 'activity' || rt.breakpoint === 'xs' || rt.breakpoint === 'sm' || rt.breakpoint === 'md';
    return (
        <GlassPanel
            // Match the tab bar's glass look: default solid fill (surface.base), not a
            // grey elevated fill. A small floating control, so a much lighter cast
            // shadow and no inset (the bar's full-strength depth reads too heavy here).
            shadowLevel={2}
            innerShadow={false}
        >
            <Pressable
                testID={props.testID}
                onPress={props.onPress}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                style={({ pressed }) => [styles.row, compact && styles.compactRow, pressed && { opacity: motionTokens.press.opacitySubtle }]}
            >
                {props.count > 0 ? (
                    <View style={styles.badge}>
                        <Text style={styles.badgeText}>{String(props.count)}</Text>
                    </View>
                ) : null}
                {!compact ? (
                    <Text style={styles.label} numberOfLines={1}>
                        {label}
                    </Text>
                ) : null}
                <Icon name="caret-down" size={16} color={theme.colors.text.primary} />
            </Pressable>
        </GlassPanel>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s10,
        paddingVertical: theme.space.s8,
    },
    compactRow: {
        minWidth: 40,
        height: 40,
        paddingHorizontal: theme.space.s8,
        paddingVertical: 0,
        justifyContent: 'center',
        gap: theme.space.s6,
    },
    badge: {
        minWidth: 18,
        height: 18,
        paddingHorizontal: theme.space.s6,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.accent.blue,
    },
    badgeText: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.surface.base,
    },
    label: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
}));
