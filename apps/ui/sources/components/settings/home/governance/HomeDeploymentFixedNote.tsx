import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { HomeSettingKeyChip } from './HomeSettingKeyChip';

/**
 * The one presentation of "this value is set by the deployment" on the Home console (plan §3.8,
 * §3.14; lab `hcFeatures-A` Voice): the quiet lead, then each env key as a small monospace chip, on
 * one line under the row's description, after a small lock. Every console page that locks a key renders this rather
 * than printing the key into its subtitle text, so the key never wraps as prose.
 *
 * Keys render through the console's one key chip (`HomeSettingKeyChip`), shared with the Server
 * settings facts line.
 *
 * `kind="unavailable"` is the same note for a capability the deployment cannot offer until it sets
 * the named keys (lab `hcPolicies-A` GitHub row): no lock, since nothing here holds a value, and the
 * lead says what is missing.
 */
export function HomeDeploymentFixedNote(props: Readonly<{
    keys: readonly string[];
    testID: string;
    kind?: 'fixed' | 'unavailable';
}>) {
    const { theme } = useUnistyles();
    if (props.keys.length === 0) return null;
    const kind = props.kind ?? 'fixed';
    return (
        <View style={styles.row}>
            {/* The lock sits on the first line when the keys wrap. */}
            {kind === 'fixed' ? (
                <View style={styles.lock}>
                    <Icon name="lock" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                </View>
            ) : null}
            <Text testID={`${props.testID}.${kind}`} style={styles.line}>
                {kind === 'fixed' ? t('homeGovernance.fixedByDeploymentLead') : t('homeGovernance.deploymentNotSetLead')}
                {' · '}
                {props.keys.map((key, index) => (
                    <React.Fragment key={key}>
                        {index > 0 ? ' ' : null}
                        <HomeSettingKeyChip envKey={key} testID={`${props.testID}.${kind}-key:${index}`} />
                    </React.Fragment>
                ))}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s4,
        minWidth: 0,
    },
    lock: {
        height: ITEM_SUBTITLE_TEXT_METRICS.comfortable.lineHeight,
        justifyContent: 'center',
    },
    line: {
        flexShrink: 1,
        ...Typography.default('regular'),
        ...ITEM_SUBTITLE_TEXT_METRICS.comfortable,
        color: theme.colors.text.secondary,
    },
}));
