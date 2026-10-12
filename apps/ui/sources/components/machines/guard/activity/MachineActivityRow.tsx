import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { MachineGuardActivityRowV1, MachineGuardActivityWayBackV1 } from '@happier-dev/protocol/machines/guard/activityV1';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { formatGuardClock } from '../guardPresentation';
import { describeGuardActivityRow, guardWayBackLabel } from './guardActivityPresentation';

/**
 * One Activity receipt (lab `RS.evt`; the single owner, reused by the Guard tab, the Activity page and
 * plan 60's widget): the time, a glyph, what happened, the bold figure and why, and the way back. A
 * decision still open reads amber, a failure rose; an undone receipt is struck through and has no
 * way back left.
 */
export const MachineActivityRow = React.memo(function MachineActivityRow(props: Readonly<{
    entry: MachineGuardActivityRowV1;
    pendingId?: string | null;
    onWayBack?: (entry: MachineGuardActivityRowV1, item: MachineGuardActivityWayBackV1) => void;
    /** Read-only (offline, or not the person's to change): the ways back are not offered. */
    readOnly?: boolean;
    showDivider?: boolean;
    /** Which machine it happened on, for a list across machines (plan 60's Activity widget). */
    place?: string;
    /** Opens what the receipt is about (the widget opens the machine's Activity). */
    onPress?: () => void;
}>) {
    const { theme } = useUnistyles();
    const model = describeGuardActivityRow(props.entry);
    const tint = model.tone === 'danger' ? theme.colors.state.danger.textForeground
        : model.tone === 'attention' ? theme.colors.state.attention.textForeground : theme.colors.text.secondary;
    const { onWayBack, entry } = props;
    const actions = props.readOnly || !onWayBack ? [] : model.wayBack;
    return (
        <Item
            testID={`machine-activity-${model.id}`}
            mode={props.onPress ? 'interactive' : 'info'}
            onPress={props.onPress}
            showDivider={props.showDivider}
            accessoryLayout="adaptive"
            leftElement={
                <View style={styles.lead}>
                    <Text style={styles.time}>{formatGuardClock(model.at)}</Text>
                    <Icon name={model.icon} size={15} color={tint} />
                </View>
            }
            title={model.title}
            titleStyle={model.undone ? styles.struck : undefined}
            subtitle={model.figure || model.reason || props.place ? (
                <Text style={styles.subtitle}>
                    {model.figure ? <Text style={styles.figure}>{model.figure}</Text> : null}
                    {[model.figure ? '' : null, model.reason, props.place].filter((part): part is string => part !== null && part !== undefined).join('  ·  ')}
                </Text>
            ) : undefined}
            rightElement={actions.length > 0 ? (
                <View style={styles.actions}>
                    {actions.map(item => (
                        <TextLinkButton key={item.label} testID={`machine-activity-${model.id}-${item.label}`} tone="strong"
                            label={guardWayBackLabel(item)} disabled={props.pendingId === `${model.id}:${item.label}`}
                            onPress={() => onWayBack!(entry, item)} />
                    ))}
                </View>
            ) : undefined}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    lead: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
    },
    time: {
        ...Typography.default(),
        ...happierPageTextMetrics('meta'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
        width: 40,
    },
    struck: {
        textDecorationLine: 'line-through',
        color: theme.colors.text.secondary,
    },
    subtitle: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
    },
    figure: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s16,
    },
}));
