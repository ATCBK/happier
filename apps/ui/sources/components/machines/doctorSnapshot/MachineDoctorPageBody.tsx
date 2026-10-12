import * as React from 'react';

import { MachineDaemonSection } from '@/components/machines/daemon/MachineDaemonSection';
import { MachineTransferExposureSection } from '@/components/machines/MachineTransferExposureSection';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';

import { MachineDoctorRuntimeInventorySection } from './MachineDoctorRuntimeInventorySection';
import { useMachineDoctorSnapshotCollection } from './useMachineDoctorSnapshotCollection';

/**
 * The Doctor sub-page: the daemon, the runtime inventory the machine's doctor reports, and what it
 * exposes for transfers. The doctor snapshot is read here (last-known first) and again on refresh.
 */
export function MachineDoctorPageBody(props: Readonly<{
    machine: Machine;
    serverId: string;
    /** No machine RPC while the focused Home is switching to this machine's. */
    switchReady: boolean;
    refreshKey: number;
}>) {
    const { machine, serverId, switchReady } = props;
    const online = useMachinePresenceSummary(serverId, machine.id).reachability === 'reachable';
    const targets = React.useMemo(() => (switchReady && serverId ? [{ machineId: machine.id, serverId }] : []), [machine.id, serverId, switchReady]);
    const prefetchTargets = React.useMemo(() => (online ? targets : []), [online, targets]);
    const { fetchMachineDoctorSnapshots, readMachineDoctorSnapshotState } = useMachineDoctorSnapshotCollection({
        machineDoctorSnapshotTargets: targets,
        prefetchMachineDoctorSnapshotTargets: prefetchTargets,
        enabled: switchReady,
    });

    const firstRefreshKey = React.useRef(props.refreshKey);
    React.useEffect(() => {
        if (props.refreshKey === firstRefreshKey.current || prefetchTargets.length === 0) return;
        void fetchMachineDoctorSnapshots(prefetchTargets);
    }, [fetchMachineDoctorSnapshots, prefetchTargets, props.refreshKey]);

    return (
        <>
            <MachineDaemonSection machine={machine} serverId={serverId} />
            {switchReady ? (
                <MachineDoctorRuntimeInventorySection
                    snapshotState={readMachineDoctorSnapshotState({ machineId: machine.id, serverId })}
                    mode="details"
                />
            ) : null}
            <MachineTransferExposureSection daemonState={machine.daemonState ?? null} />
        </>
    );
}
