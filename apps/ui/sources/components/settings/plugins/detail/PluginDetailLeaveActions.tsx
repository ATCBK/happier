import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { usePluginAccountDataErase } from '../PluginAccountDataEraseRecoverySection';

/**
 * How a plugin page ends: the quiet actions that remove it. Uninstall is the common exit (bordered),
 * forgetting trust is rarer (text), and erasing its retained Account data — the one that cannot be
 * undone — stands apart at the end, with its consequence stated once underneath.
 */
export function PluginDetailLeaveActions(props: Readonly<{
    pluginId: string;
    uninstall?: Readonly<{ disabled: boolean; onPress: () => void }> | null;
    forgetTrust?: Readonly<{ disabled: boolean; onPress: () => void }> | null;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { erase, pending } = usePluginAccountDataErase(props.pluginId);
    return (
        <ItemGroup surface="none" accessibilityLabel={t('settingsPlugins.accountDataErase.installedGroupTitle')}>
            <View style={styles.actions}>
                {props.uninstall ? (
                    <RoundButton
                        testID={`settings.plugins.detail.${props.pluginId}.action.uninstall`}
                        size="small"
                        display="secondary"
                        leading={<Icon name="trash" size={15} color={theme.colors.text.primary} />}
                        title={t('settingsPlugins.uninstall')}
                        disabled={props.uninstall.disabled}
                        onPress={props.uninstall.onPress}
                    />
                ) : null}
                {props.forgetTrust ? (
                    <RoundButton
                        testID={`settings.plugins.detail.${props.pluginId}.action.forgetTrust`}
                        size="small"
                        display="inverted"
                        textStyle={styles.quietAction}
                        title={t('settingsPlugins.forgetTrust')}
                        disabled={props.forgetTrust.disabled}
                        onPress={props.forgetTrust.onPress}
                    />
                ) : null}
                <View style={styles.spacer} />
                <RoundButton
                    testID={`settings.plugins.detail.${props.pluginId}.accountDataErase`}
                    size="small"
                    display="destructive"
                    title={t('settingsPlugins.accountDataErase.installedEntryTitle')}
                    titleNumberOfLines="complete"
                    accessibilityHint={t('settingsPlugins.accountDataErase.installedEntrySubtitle')}
                    disabled={pending}
                    loading={pending}
                    onPress={erase}
                />
            </View>
            <Text style={styles.footnote}>{t('settingsPlugins.accountDataErase.installedGroupFooter')}</Text>
        </ItemGroup>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    actions: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    // Pushes the irreversible erase to the far edge when the row fits, apart from the recoverable ones.
    spacer: {
        flexGrow: 1,
    },
    quietAction: {
        ...Typography.variant('body', 'medium'),
        color: theme.colors.text.secondary,
    },
    footnote: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        marginTop: theme.space.s10,
        marginHorizontal: theme.space.s2,
    },
}));
