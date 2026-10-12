import * as React from 'react';

import { CAPABILITIES_REQUEST_MACHINE_DETAILS } from '@/capabilities/requests';
import { resolveTmuxAvailable } from '@/capabilities/tmuxAvailability';
import { MachineWindowsLaunchSection } from '@/components/machines/windows/MachineWindowsLaunchSection';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';

import { MachineTerminalSettingsSection } from './MachineTerminalSettingsSection';

/**
 * The Terminal sub-page: the terminal host new sessions use here and, on Windows, how remote sessions
 * open. The machine's detected tools (tmux, Windows Terminal) are asked for here, where they are shown,
 * and again on the page's refresh.
 */
export function MachineTerminalPageBody(props: Readonly<{
    machine: Machine;
    serverId: string;
    /** No machine RPC while the focused Home is switching to this machine's. */
    isServerSwitching: boolean;
    refreshKey: number;
}>) {
    const { machine } = props;
    const presence = useMachinePresenceSummary(props.serverId, machine.id);
    const { state: detected, refresh } = useMachineCapabilitiesCache({
        machineId: machine.id,
        serverId: props.serverId,
        cacheKeySalt: machine.daemonStateVersion ?? 0,
        enabled: presence.reachability === 'reachable' && !props.isServerSwitching,
        request: CAPABILITIES_REQUEST_MACHINE_DETAILS,
    });
    const snapshot = detected.status === 'loaded' || detected.status === 'loading' || detected.status === 'error'
        ? detected.snapshot
        : undefined;
    const tmuxAvailable = resolveTmuxAvailable(snapshot?.response);
    const windowsTerminalAvailable = machine.metadata?.platform === 'win32'
        && (snapshot?.response.results as Record<string, { data?: { available?: unknown } } | undefined> | undefined)?.['tool.windowsTerminal']?.data?.available === true;

    const firstRefreshKey = React.useRef(props.refreshKey);
    React.useEffect(() => {
        if (props.refreshKey === firstRefreshKey.current) return;
        refresh({ bypassCache: true });
    }, [props.refreshKey, refresh]);

    return (
        <>
            <MachineTerminalSettingsSection machineId={machine.id} serverId={props.serverId} tmuxAvailable={tmuxAvailable} />
            <MachineWindowsLaunchSection machine={machine} serverId={props.serverId} windowsTerminalAvailable={windowsTerminalAvailable} />
        </>
    );
}
