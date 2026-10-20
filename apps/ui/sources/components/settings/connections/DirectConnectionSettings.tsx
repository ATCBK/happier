import * as React from 'react';

import { PeerMediationPreferencesV1Schema, type PeerMediationPreferencesV1 } from '@happier-dev/protocol/account/settings/peerMediationPreferencesV1';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';

import { ACCOUNT_SETTINGS } from '@/components/settings/account/accountSettings';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import {
    readDirectConnectionsEnabled,
    readMachineDirectConnectionChoice,
    type MachineDirectConnectionChoice,
} from '@/sync/domains/settings/peerMediationPreferences';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

/**
 * Whether the Home's server lets any flow connect directly. The server gate is the first input of the
 * fold owner (`resolveEffectivePeerDirectRoutePolicy`); when every direct-peer bit is off, no account
 * or machine choice can change a route, so the rows say so instead of offering a switch that does
 * nothing. A bit that has not been read yet is not a refusal: the rows stay usable until every answer
 * is in and none allows it.
 */
function useServerDeniesDirectConnections(): boolean {
    const rpc = useFeatureDecision('machines.rpc.directPeer' satisfies FeatureId);
    const transfer = useFeatureDecision('machines.transfer.directPeer' satisfies FeatureId);
    const tunnel = useFeatureDecision('machines.tunnel.directPeer' satisfies FeatureId);
    const liveStream = useFeatureDecision('machines.liveStream.directPeer' satisfies FeatureId);
    const decisions = [rpc, transfer, tunnel, liveStream];
    return decisions.every((decision) => decision !== null && (decision.state === 'disabled' || decision.state === 'unsupported'));
}

/**
 * The stored value through its canonical schema (which falls back to the defaults rather than
 * throwing), so a missing or foreign value reads as "never changed" instead of breaking the page.
 */
function usePeerMediationPreferences(): PeerMediationPreferencesV1 {
    const stored = useSetting('peerMediationPreferencesV1');
    return React.useMemo(() => PeerMediationPreferencesV1Schema.parse(stored), [stored]);
}

/** Account › Connections: one account-wide answer to "may my devices connect to my machines directly?". */
export const AccountDirectConnectionsSection = React.memo(function AccountDirectConnectionsSection() {
    const preferences = usePeerMediationPreferences();
    const { setSetting } = useSettingActionFeedback();
    const serverDenies = useServerDeniesDirectConnections();
    const enabled = !serverDenies && readDirectConnectionsEnabled(preferences);
    const subtitle = serverDenies
        ? t('settingsConnections.serverDenied')
        : enabled ? t('settingsConnections.directOnDescription') : t('settingsConnections.directOffDescription');
    return (
        <ItemGroup title={t('settingsConnections.sectionTitle')} description={t('settingsConnections.sectionDescription')}>
            <SettingRow
                testID="settings-account-direct-connections-item"
                setting={ACCOUNT_SETTINGS.settings.directConnections}
                subtitle={subtitle}
                disabled={serverDenies}
                showChevron={false}
                rightElement={
                    <Switch
                        testID="settings-account-direct-connections-switch"
                        value={enabled}
                        disabled={serverDenies}
                        onValueChange={(value) => { void setSetting(ACCOUNT_SETTINGS.settings.directConnections, value); }}
                    />
                }
            />
        </ItemGroup>
    );
});

/**
 * The machine's Connection answer in a few words, for its This machine row: the choice the section
 * shows, read from the same preferences (no request).
 */
export function useMachineDirectConnectionSummary(machineId: string): string {
    const preferences = usePeerMediationPreferences();
    const serverDenies = useServerDeniesDirectConnections();
    const choice = serverDenies ? 'relay' : readMachineDirectConnectionChoice(preferences, machineId);
    return choice === 'direct' ? t('settingsConnections.machineOptionDirect')
        : choice === 'relay' ? t('settingsConnections.machineOptionRelay')
            : t('machineDetailPage.connectionFollowsAccount');
}

/**
 * A machine's Connection section: follow the account, or override it for this machine only
 * (`byMachineId`). Three short answers, all visible.
 */
export const MachineDirectConnectionSection = React.memo(function MachineDirectConnectionSection(props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
}>) {
    const preferences = usePeerMediationPreferences();
    const { setSetting } = useSettingActionFeedback({ serverId: props.serverId });
    const serverDenies = useServerDeniesDirectConnections();
    const choice = serverDenies ? 'relay' : readMachineDirectConnectionChoice(preferences, props.machineId);
    const accountEnabled = readDirectConnectionsEnabled(preferences);
    const machine = props.machineName;
    const options = React.useMemo((): ReadonlyArray<SegmentedChoiceOption<MachineDirectConnectionChoice>> => [
        {
            id: 'default',
            label: t('settingsConnections.machineOptionDefault'),
            description: accountEnabled
                ? t('settingsConnections.machineDefaultDescription', { machine })
                : t('settingsConnections.machineDefaultOffDescription'),
        },
        { id: 'direct', label: t('settingsConnections.machineOptionDirect'), description: t('settingsConnections.machineDirectDescription', { machine }) },
        { id: 'relay', label: t('settingsConnections.machineOptionRelay'), description: t('settingsConnections.machineRelayDescription') },
    ], [accountEnabled, machine]);
    return (
        // The page header already says "Connection"; the section repeats nothing (Sharing's page does the same).
        <ItemGroup>
            <SegmentedChoiceItem<MachineDirectConnectionChoice>
                testID="machine-direct-connection-item"
                testIDPrefix="machine-direct-connection"
                title={t('settingsConnections.machineTitle', { machine })}
                subtitle={serverDenies ? t('settingsConnections.serverDenied') : undefined}
                options={serverDenies ? options.map((option) => ({ ...option, description: undefined })) : options}
                value={choice}
                disabled={serverDenies}
                onChange={(next) => { void setSetting({ anchor: 'machines.connection.direct', key: props.machineId }, next); }}
            />
        </ItemGroup>
    );
});
