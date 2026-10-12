import * as React from 'react';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Modal } from '@/modal';
import { resolveTerminalHost } from '@/sync/domains/settings/terminalSettings';
import { useSetting, useSettings } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * How new sessions on this machine use a terminal host (Terminal sub-page): follow the account's host,
 * or override it here with its tmux details. Changes go through the keyed `machines.terminal.host`
 * setting, so they are the same Action an agent would use.
 */
export const MachineTerminalSettingsSection = React.memo(function MachineTerminalSettingsSection(props: Readonly<{
    machineId: string;
    serverId: string;
    /** Whether the machine reported tmux; `null` while unknown. */
    tmuxAvailable: boolean | null;
}>) {
    const { machineId, tmuxAvailable } = props;
    const stopExecution = useMountedActionExecution(props.serverId);
    const settings = useSettings();
    const terminalTmuxByMachineId = useSetting('sessionTmuxByMachineId');
    const tmuxOverride = machineId && terminalTmuxByMachineId && Object.hasOwn(terminalTmuxByMachineId, machineId)
        ? terminalTmuxByMachineId[machineId] : undefined;
    const tmuxOverrideEnabled = Boolean(tmuxOverride || (machineId && Object.hasOwn(settings.sessionTerminalHostByMachineId, machineId)));
    const selectedGlobalTerminalHost = resolveTerminalHost({ settings, machineId: null });
    const selectedMachineTerminalHost = resolveTerminalHost({ settings, machineId: machineId ?? null });

    const setTmuxOverrideEnabled = React.useCallback((enabled: boolean) => {
        if (!machineId) return;
        fireAndForget((async () => {
            const result = await stopExecution.execute('settings.set', { anchor: 'machines.terminal.host', key: machineId,
                value: { host: enabled ? selectedGlobalTerminalHost : null } });
            if (!result.ok) Modal.alert(t('common.error'), result.error);
        })(), { tag: 'MachineTerminalSettingsSection.setTerminalHostOverride' });
    }, [machineId, stopExecution, selectedGlobalTerminalHost]);

    const updateTmuxOverride = React.useCallback((patch: Partial<NonNullable<typeof tmuxOverride>>) => {
        if (!machineId || !tmuxOverride) return;
        const { useTmux: _host, ...tmux } = patch;
        fireAndForget((async () => {
            const result = await stopExecution.execute('settings.set', { anchor: 'machines.terminal.host', key: machineId,
                value: { tmux } });
            if (!result.ok) Modal.alert(t('common.error'), result.error);
        })(), { tag: 'MachineTerminalSettingsSection.updateTmuxOverride' });
    }, [machineId, stopExecution, tmuxOverride]);

    const setTerminalHostOverride = React.useCallback((next: 'none' | 'tmux' | 'zellij' | 'herdr') => {
        if (next === 'tmux' && tmuxAvailable === false) {
            Modal.alert(t('common.error'), t('machine.tmux.notDetectedMessage'));
            return;
        }
        if (!machineId) return;
        fireAndForget((async () => {
            const result = await stopExecution.execute('settings.set', { anchor: 'machines.terminal.host', key: machineId,
                value: { host: next } });
            if (!result.ok) Modal.alert(t('common.error'), result.error);
        })(), { tag: 'MachineTerminalSettingsSection.setTerminalHost' });
    }, [tmuxAvailable, machineId, stopExecution]);

    return (
        <ItemGroup title={t('settingsSessionPages.runtime.terminalSection')} description={t('settingsSessionPages.runtime.pageDescription')}>
            <Item
                title={t('machine.tmux.overrideTitle')}
                subtitle={tmuxOverrideEnabled ? t('machine.tmux.overrideEnabledSubtitle') : t('machine.tmux.overrideDisabledSubtitle')}
                rightElement={<Switch value={tmuxOverrideEnabled} onValueChange={setTmuxOverrideEnabled} />}
                showChevron={false}
                onPress={() => setTmuxOverrideEnabled(!tmuxOverrideEnabled)}
            />

            {!tmuxOverrideEnabled && (
                <Item
                    testID="machine-terminal-effective-host"
                    title={t('settingsSessionPages.runtime.terminalHostTitle')}
                    subtitle={selectedMachineTerminalHost === 'none'
                        ? t('settingsSessionPages.runtime.terminalHostNone')
                        : selectedMachineTerminalHost === 'herdr' ? 'Herdr'
                            : selectedMachineTerminalHost === 'zellij' ? 'Zellij' : 'tmux'}
                    mode="info"
                    showChevron={false}
                />
            )}

            {tmuxOverrideEnabled && (
                <>
                    <SegmentedChoiceItem<'none' | 'tmux' | 'zellij' | 'herdr'>
                        title={t('settingsSessionPages.runtime.terminalHostTitle')}
                        options={[
                            { id: 'none', label: t('settingsSessionPages.runtime.terminalHostNone') },
                            { id: 'tmux', label: 'tmux', unavailableReason: tmuxAvailable === false ? t('machine.tmux.notDetectedSubtitle') : undefined },
                            { id: 'zellij', label: 'Zellij' },
                            { id: 'herdr', label: 'Herdr' },
                        ]}
                        value={selectedMachineTerminalHost}
                        onChange={setTerminalHostOverride}
                    />

                    {selectedMachineTerminalHost === 'tmux' && tmuxOverride && (
                        <>
                            <Item
                                title={t('profiles.tmuxSession')}
                                subtitle={t('common.optional')}
                                showChevron={false}
                                mode="info"
                                accessoryLayout="adaptive"
                                rightElement={(
                                    <FieldTextInput
                                        accessibilityLabel={t('profiles.tmuxSession')}
                                        placeholder={t('profiles.tmux.sessionNamePlaceholder')}
                                        value={tmuxOverride.sessionName}
                                        onChangeText={(value) => updateTmuxOverride({ sessionName: value })}
                                        autoCapitalize="none"
                                        monospace
                                    />
                                )}
                            />

                            <Item
                                title={t('profiles.tmux.isolatedServerTitle')}
                                subtitle={tmuxOverride.isolated ? t('profiles.tmux.isolatedServerEnabledSubtitle') : t('profiles.tmux.isolatedServerDisabledSubtitle')}
                                rightElement={<Switch value={tmuxOverride.isolated} onValueChange={(next) => updateTmuxOverride({ isolated: next })} />}
                                showChevron={false}
                                onPress={() => updateTmuxOverride({ isolated: !tmuxOverride.isolated })}
                            />

                            {tmuxOverride.isolated && (
                                <Item
                                    title={t('profiles.tmuxTempDir')}
                                    subtitle={t('common.optional')}
                                    showChevron={false}
                                    mode="info"
                                    accessoryLayout="adaptive"
                                    rightElement={(
                                        <FieldTextInput
                                            accessibilityLabel={t('profiles.tmuxTempDir')}
                                            placeholder={t('profiles.tmux.tempDirPlaceholder')}
                                            value={tmuxOverride.tmpDir ?? ''}
                                            onChangeText={(value) => updateTmuxOverride({ tmpDir: value.trim().length > 0 ? value : null })}
                                            autoCapitalize="none"
                                            monospace
                                        />
                                    )}
                                />
                            )}
                        </>
                    )}
                </>
            )}
        </ItemGroup>
    );
});
