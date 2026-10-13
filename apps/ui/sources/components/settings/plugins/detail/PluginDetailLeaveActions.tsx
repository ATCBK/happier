import * as React from 'react';

import { PageLeaveActions, type PageLeaveAction } from '@/components/ui/layout/PageLeaveActions';
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
    const { erase, pending } = usePluginAccountDataErase(props.pluginId);
    const actions: PageLeaveAction[] = [];
    if (props.uninstall) actions.push({
        testID: `settings.plugins.detail.${props.pluginId}.action.uninstall`,
        display: 'bordered',
        icon: 'trash',
        label: t('settingsPlugins.uninstall'),
        disabled: props.uninstall.disabled,
        onPress: props.uninstall.onPress,
    });
    if (props.forgetTrust) actions.push({
        testID: `settings.plugins.detail.${props.pluginId}.action.forgetTrust`,
        display: 'text',
        label: t('settingsPlugins.forgetTrust'),
        disabled: props.forgetTrust.disabled,
        onPress: props.forgetTrust.onPress,
    });
    actions.push({
        testID: `settings.plugins.detail.${props.pluginId}.accountDataErase`,
        display: 'destructive',
        label: t('settingsPlugins.accountDataErase.installedEntryTitle'),
        accessibilityHint: t('settingsPlugins.accountDataErase.installedEntrySubtitle'),
        busy: pending,
        onPress: erase,
    });
    return (
        <PageLeaveActions
            accessibilityLabel={t('settingsPlugins.accountDataErase.installedGroupTitle')}
            actions={actions}
            footnote={t('settingsPlugins.accountDataErase.installedGroupFooter')}
        />
    );
}
