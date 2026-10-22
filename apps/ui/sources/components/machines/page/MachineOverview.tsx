import * as React from 'react';

import { MachineVitalsOverview } from '@/components/machines/vitals/MachineVitalsOverview';
import { ManagedEnrolledMachineSectionsView } from '@/components/settings/machines/managed/ManagedMachineSections';
import { managedPowerExplainsOffline } from '@/components/settings/machines/managed/managedCreationPresentation';
import { splitHappierBannerPoint } from '@happier-dev/plugin-ui/presentation';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { canAttemptMachineSpawn } from '@/sync/domains/machines/identity/resolveMachineSpawnReadiness';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

import { MachineCapabilitiesSection } from './MachineCapabilitiesSection';
import { MachineThisMachineSection } from './MachineThisMachineSection';
import { MachineResourcesAskBlock } from '@/components/machines/resources/ask/MachineResourcesAskBlock';
import { useMachinePageState } from './machinePageContext';
import type { MachinePageTabBodyProps } from './machinePageTabQuery';

/** The CLI commands the offline checks name; commands are never translated, so they are matched literally. */
const OFFLINE_HELP_COMMANDS = ['happier daemon status', 'happier self update'] as const;

/** The offline checks, one point per line of the translated help, with each command in the mono role. */
function offlineHelpPoints() {
    return t('machine.offlineHelp').split('\n')
        .map((line) => line.replace(/^\s*•\s*/, '').trim())
        .filter(Boolean)
        .map((line) => splitHappierBannerPoint(line, OFFLINE_HELP_COMMANDS));
}

/**
 * The machine page's Overview (MPG-8): what blocks use first, then (for a machine Happier created)
 * Managed, then plan 20's vitals body (CPU, memory, disk, network, what else the machine reports and its
 * Alerts), Ask an agent, then "This machine", whose rows push the machine's work (Project work: workers,
 * runs, recent sessions, project terminals) and its own settings and diagnostics (lab `R`).
 */
export function MachineOverview(props: MachinePageTabBodyProps) {
    const { target, managedEnrolled, reload } = useMachinePageState();
    const machine = target.machine;
    const { binding } = useServerCredentialAccountScopeBinding(target.serverId);
    const machineAccountScope = binding?.isCurrent() ? binding.scope : null;
    const canSpawn = React.useMemo(
        () => target.online && canAttemptMachineSpawn({ machine: machine ?? undefined, selectedMachineId: props.machineId, scope: machineAccountScope }),
        [machine, props.machineId, machineAccountScope, target.online],
    );
    // The unavailable banner's Retry: the page's reload, with its own progress on the button. It is
    // not a pull-to-refresh, so it neither records one nor spins the list's refresh control.
    const [retrying, setRetrying] = React.useState(false);
    const retry = React.useCallback(async () => {
        setRetrying(true);
        try {
            await reload();
        } finally {
            setRetrying(false);
        }
    }, [reload]);
    const offlineRetry = React.useMemo(() => ({ onPress: () => void retry(), loading: retrying }), [retry, retrying]);
    const { setParams } = props;
    const openProcesses = React.useCallback(() => setParams({ id: 'processes' }), [setParams]);

    if (!machine) return null;
    return (
        <>
            {/* An offline machine is a fact, not a fault: the vitals body below says it once, in its quiet banner above
                what the machine last reported (lab `rv` OS 3). Only a machine that is online but still cannot start
                sessions gets the checks. */}
            {props.online && !canSpawn ? (
                <AttentionBanner
                    testID="machine-detail-unavailable"
                    tone="warning"
                    title={t('machineDetailPage.unavailableTitle')}
                    points={offlineHelpPoints()}
                    action={{ label: t('common.retry'), onPress: () => void retry(), loading: retrying, disabled: retrying }}
                />
            ) : null}

            {/* A machine Happier created explains itself first (lab m-detail): Keep it, Managed from and
                what it was made with, beside its receipt, before the sections every machine has. */}
            <ManagedEnrolledMachineSectionsView enrolled={managedEnrolled} />

            {/* Plan 20's vitals body: live while this tab is shown, its history and Alerts row. */}
            <MachineVitalsOverview serverId={props.serverId} machine={machine} machineName={props.machineName} online={props.online}
                rangeInBar={props.barAccessoryShown} onOpenProcesses={openProcesses} offlineRetry={offlineRetry}
                offlineExplained={managedPowerExplainsOffline(managedEnrolled.machine)} />

            {/* The page answers first; the agent is there when it is not enough (lab `ra` A1). */}
            <MachineResourcesAskBlock serverId={props.serverId} machineId={props.machineId} machineName={props.machineName} />

            {/* Skills and MCP servers (Capabilities P8 U8.6): what sessions on this machine get, before This machine. */}
            <MachineCapabilitiesSection machineId={props.machineId} machineName={props.machineName} offline={props.online === false} />

            {/* Project work (the workspaces held here; its page has workers, runs, recent sessions, terminals), then This machine. */}
            <MachineThisMachineSection serverId={props.serverId} machine={machine} />
        </>
    );
}
