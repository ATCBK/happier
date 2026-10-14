import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

export function SourceControlSessionInactiveState(props: {
    machineReachable: boolean;
    onOpenSession?: () => void;
}): React.ReactElement {
    const { theme } = useUnistyles();
    const titleKey = props.machineReachable ? 'session.inactiveResumable' : 'session.inactiveMachineOffline';
    const subtitleKey = props.machineReachable ? 'errors.tryAgain' : 'session.machineOfflineCannotResume';

    return (
        <View
            style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                paddingTop: theme.space.s40,
                paddingHorizontal: theme.space.s20,
                gap: 14,
            }}
        >
            <Icon name="warning" size={42} color={theme.colors.text.secondary} />

            <Text
                style={{
                    fontSize: 16,
                    color: theme.colors.text.secondary,
                    textAlign: 'center',
                    ...Typography.default(),
                }}
            >
                {t(titleKey)}
            </Text>

            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.text.secondary,
                    textAlign: 'center',
                    ...Typography.default(),
                }}
            >
                {t(subtitleKey)}
            </Text>

            {props.onOpenSession && (
                <View style={{ marginTop: theme.space.s6 }}>
                    <RoundButton size="normal" title={t('common.continue')} onPress={props.onOpenSession} />
                </View>
            )}
        </View>
    );
}
