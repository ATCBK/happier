import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const MINIMUM_TARGET = resolveMinimumInteractiveTargetSize(Platform.OS);

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        minWidth: MINIMUM_TARGET,
        minHeight: MINIMUM_TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: theme.space.s6,
    },
    title: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 14,
    },
    count: {
        ...Typography.default(),
        color: theme.colors.text.tertiary,
        fontSize: 14,
        fontVariant: ['tabular-nums'],
    },
}));

/**
 * "How it got there · N steps" (agents lab RP1): the one row that opens a finished Run's transcript
 * under its result, and closes it again.
 */
export const ExecutionRunStepsRow = React.memo((props: Readonly<{
    expanded: boolean;
    stepCount: number;
    onToggle: () => void;
}>) => {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    return (
        <Pressable
            testID="session-run-details-steps"
            accessibilityRole="button"
            accessibilityState={{ expanded: props.expanded }}
            onPress={props.onToggle}
            style={styles.row}
        >
            <Icon name={props.expanded ? 'caret-down' : 'caret-right'} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text style={styles.title}>
                {t('runPage.steps.title')}
                {props.stepCount > 0 ? (
                    <Text style={styles.count}>{` · ${t('runPage.steps.count', { count: props.stepCount })}`}</Text>
                ) : null}
            </Text>
        </Pressable>
    );
});
