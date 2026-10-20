import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { StatusPill } from '@/components/ui/status/StatusPill';

import { presentCapabilityStatus, type CapabilityStatus, type CapabilityStatusPlacement } from './capabilityStatusPresentation';

/**
 * A capability status where it speaks: the pill from the one status-words owner, and its one fix beside it. Silent
 * statuses (ready, and `off` in rows) draw nothing.
 */
export const CapabilityStatusChip = React.memo(function CapabilityStatusChip(props: Readonly<{
    status: CapabilityStatus;
    placement?: CapabilityStatusPlacement;
    /** In a list's facts line the fix stays in the row's action column; the chip alone is drawn. */
    showFix?: boolean;
    testID?: string;
}>) {
    const presentation = presentCapabilityStatus(props.status, props.placement ?? 'row');
    const pill = presentation.pill;
    if (pill === null) return null;
    const fix = props.status.fix;
    return (
        <View style={styles.root} testID={props.testID}>
        <View style={styles.row}>
            <StatusPill
                variant={pill.variant}
                chrome={pill.chrome}
                label={pill.label}
                labelVariant="phrase"
                labelNumberOfLines={1}
                {...(pill.detail === undefined ? {} : { detail: pill.detail })}
            />
            {props.showFix === true && fix !== undefined && presentation.fixLabel !== undefined ? (
                <RoundButton
                    size="small"
                    display="secondary"
                    title={presentation.fixLabel}
                    onPress={fix.onPress}
                    {...(props.testID === undefined ? {} : { testID: `${props.testID}:fix` })}
                />
            ) : null}
        </View>
        {presentation.reason === undefined ? null : (
            <Text variant="meta" style={styles.reason}>{presentation.reason}</Text>
        )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    // The pill says the state short; a reason (why it stopped) wraps under it, whole.
    root: { gap: theme.space.s2, minWidth: 0, flexShrink: 1 },
    reason: { color: theme.colors.text.secondary },
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minWidth: 0, flexShrink: 1 },
}));
