import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveHomeDisplayNameForRelayUrl } from '@/components/settings/server/homeDisplayName';
import { t } from '@/text';

export type ActiveRelaySummaryProps = Readonly<{
    relayUrl: string;
    status: 'active' | 'selected';
    idPrefix?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
        borderRadius: 10,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    copy: {
        flex: 1,
        minWidth: 0,
        gap: 1,
    },
    label: {
        color: theme.colors.text.primary,
        ...Typography.variant('meta', 'semiBold'),
    },
    value: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta'),
    },
}));

export function ActiveRelaySummary(props: ActiveRelaySummaryProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const label = props.status === 'active'
        ? t('setupOnboarding.activeRelaySummaryTitle')
        : t('setupOnboarding.selectedRelaySummaryTitle');

    return (
        <View testID={props.idPrefix} style={styles.container}>
            <Icon name={props.status === 'active' ? 'cloud-check' : 'cloud'} size={18} color={theme.colors.text.secondary} />
            <View style={styles.copy}>
                <Text testID={`${props.idPrefix ?? 'relay-summary'}-label`} style={styles.label}>{label}</Text>
                <Text
                    testID={`${props.idPrefix ?? 'relay-summary'}-line`}
                    style={styles.value}
                >
                    {resolveHomeDisplayNameForRelayUrl(props.relayUrl) ?? t('settingsAccount.thisHomeTitle')}
                </Text>
            </View>
        </View>
    );
}
