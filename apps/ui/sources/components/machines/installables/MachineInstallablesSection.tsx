import React from 'react';

import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { InstallableDepInstaller } from '@/components/machines/InstallableDepInstaller';
import { Switch } from '@/components/ui/forms/Switch';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachine, useSettings } from '@/sync/domains/state/storage';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { CAPABILITIES_REQUEST_MACHINE_DETAILS } from '@/capabilities/requests';
import { getInstallablesRegistryEntries, type InstallableAutoUpdateMode } from '@/capabilities/installablesRegistry';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { resolveInstallablePolicy } from '@happier-dev/protocol/installablesPolicy';
import { getPreferredLanguage, t } from '@/text';
import { Modal } from '@/modal';

function buildAutoUpdateModeOptions(): ReadonlyArray<SegmentedChoiceOption<InstallableAutoUpdateMode>> {
    return [
        { id: 'off', label: t('machine.installables.autoUpdateModes.off') },
        { id: 'notify', label: t('machine.installables.autoUpdateModes.notify') },
        { id: 'auto', label: t('machine.installables.autoUpdateModes.auto') },
    ];
}

/**
 * The machine's tools that are not agents (Tools sub-page): each installable with its status, install
 * or update, and its auto-install and auto-update policy. Agents and their parts install from the
 * machine's Agents page (lab agent-setup M1).
 */
export function MachineInstallablesSection(props: Readonly<{ machineId: string; serverId: string }>) {
    const { machineId, serverId } = props;
    const machine = useMachine(machineId);
    const presence = useMachinePresenceSummary(serverId, machineId);
    const isOnline = !!machine && presence.reachability === 'reachable';

    const settings = useSettings();
    const policyAction = useMountedActionExecution(serverId);

    const { state: detectedCapabilities, refresh: refreshDetectedCapabilities } = useMachineCapabilitiesCache({
        machineId: machineId ?? null,
        serverId,
        enabled: Boolean(machineId && isOnline),
        request: CAPABILITIES_REQUEST_MACHINE_DETAILS,
    });
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: machineId ?? null,
        serverId,
        // Offline, the last projected metadata stays visible (read-only); only an online machine is asked.
        enabled: Boolean(machineId),
        load: isOnline,
    });
    // Stale metadata labels the rows; installing stays gated on the live capabilities status.
    const daemonMergedProjectionInputs = daemonMergedProjection.inputs;

    const capabilitiesSnapshot = React.useMemo(() => {
        const snapshot =
            detectedCapabilities.status === 'loaded'
                ? detectedCapabilities.snapshot
                : detectedCapabilities.status === 'loading'
                    ? detectedCapabilities.snapshot
                    : detectedCapabilities.status === 'error'
                        ? detectedCapabilities.snapshot
                        : undefined;
        return snapshot ?? null;
    }, [detectedCapabilities]);

    const installables = React.useMemo(() => {
        const entries = getInstallablesRegistryEntries({
            pluginProjection: daemonMergedProjectionInputs?.pluginProjectionV2 ?? undefined,
        });
        const results = capabilitiesSnapshot?.response.results;
        return entries.map((entry) => {
            const enabled = entry.enabledWhen(settings as any);
            const status = entry.getStatus(results);
            const detectResult = entry.getDetectResult(results);
            const policy = resolveInstallablePolicy({
                settings: settings as any,
                machineId: machineId ?? '',
                installableKey: entry.key,
                defaults: entry.defaultPolicy,
            });
            return { entry, enabled, status, detectResult, policy };
        });
    }, [capabilitiesSnapshot, daemonMergedProjectionInputs?.pluginProjectionV2, machineId, settings]);

    React.useEffect(() => {
        if (!machineId) return;
        if (!isOnline) return;
        const results = capabilitiesSnapshot?.response.results;
        if (!results) return;

        const requests = installables
            .filter((d) => d.enabled)
            .filter((d) => d.entry.shouldPrefetchLatestVersion({ requireExistingResult: true, result: d.detectResult, data: d.status }))
            .flatMap((d) => d.entry.buildLatestVersionDetectRequest().requests ?? []);

        if (requests.length === 0) return;

        refreshDetectedCapabilities({
            request: { requests },
            timeoutMs: 12_000,
        });
    }, [capabilitiesSnapshot, installables, isOnline, machineId, refreshDetectedCapabilities]);

    const setPolicyPatch = React.useCallback((installableKey: string, patch: { autoInstallWhenNeeded?: boolean; autoUpdateMode?: InstallableAutoUpdateMode }) => {
        if (!machineId) return;
        void policyAction.execute('settings.set', { anchor: 'machines.installables.policy', key: machineId,
            value: { installableKey, patch } }).then(result => {
            if (!result.ok) Modal.alert(t('common.error'), result.error);
        }).catch(error => {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.requestFailed'));
        });
    }, [machineId, policyAction.execute]);

    // Labels come from `t()`, so the options are rebuilt when the language changes.
    const preferredLanguage = getPreferredLanguage();
    const autoUpdateModeOptions = React.useMemo(buildAutoUpdateModeOptions, [preferredLanguage]);

    return (
        <>
            {installables.map(({ entry, enabled, status, policy }) => {
                if (!enabled) return null;
                return (
                    <InstallableDepInstaller
                        key={entry.key}
                        machineId={machineId ?? ''}
                        serverId={serverId}
                        enabled={true}
                        groupTitle={entry.experimental ? t('machine.installables.experimentalGroupTitle', { title: entry.title }) : entry.title}
                        depId={entry.capabilityId}
                        depTitle={entry.title}
                        depSubtitle={entry.subtitle}
                        depIconName={entry.iconName as any}
                        setupUrl={entry.setupUrl}
                        depStatus={status}
                        capabilitiesStatus={isOnline ? detectedCapabilities.status : 'idle'}
                        extraItems={
                            <>
                                <Item
                                    title={t('machine.installables.autoInstallTitle')}
                                    subtitle={t('machine.installables.autoInstallSubtitle')}
                                    rightElement={<Switch value={policy.autoInstallWhenNeeded} onValueChange={(next) => setPolicyPatch(entry.key, { autoInstallWhenNeeded: next })} />}
                                    showChevron={false}
                                    onPress={() => setPolicyPatch(entry.key, { autoInstallWhenNeeded: !policy.autoInstallWhenNeeded })}
                                />
                                <SegmentedChoiceItem<InstallableAutoUpdateMode>
                                    title={t('machine.installables.autoUpdateTitle')}
                                    subtitle={t('machine.installables.autoUpdatePromptBody')}
                                    options={autoUpdateModeOptions}
                                    value={policy.autoUpdateMode}
                                    onChange={(next) => setPolicyPatch(entry.key, { autoUpdateMode: next })}
                                    testIDPrefix={`machine-installables-auto-update-${entry.key}`}
                                />
                            </>
                        }
                        installLabels={{
                            install: entry.installLabels.install,
                            update: entry.installLabels.update,
                            reinstall: entry.installLabels.reinstall,
                        }}
                        installModal={{
                            installTitle: entry.installModal.installTitle,
                            updateTitle: entry.installModal.updateTitle,
                            reinstallTitle: entry.installModal.reinstallTitle,
                            description: entry.installModal.description,
                        }}
                        refreshStatus={() => refreshDetectedCapabilities()}
                        refreshLatestVersion={isOnline
                            ? () => refreshDetectedCapabilities({ request: entry.buildLatestVersionDetectRequest(), timeoutMs: 12_000 })
                            : undefined}
                    />
                );
            })}
        </>
    );
}
