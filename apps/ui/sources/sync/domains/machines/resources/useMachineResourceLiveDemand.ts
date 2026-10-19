import * as React from 'react';
import { useMachineDaemonReadIdentities } from '../useMachineDaemonReadTarget';
import { machineResourceStore } from './machineResourceStore';
import type { MachineResourceKey, MachineVitalsView } from './machineRpc';

/** Mounted visible surfaces own demand; passive row readers never start an RPC. */
export function useMachineResourceLiveDemand(machineKeys: readonly MachineResourceKey[], options: Readonly<{ detail: MachineVitalsView; enabled?: boolean }>): void {
    const identities = useMachineDaemonReadIdentities(machineKeys.map(input => ({ ...input, enabled: options.enabled })));
    const versionsKey = JSON.stringify(identities.map((target, index) => ({ ...target.key,
        daemonStateVersion: machineKeys[index]?.daemonStateVersion })));

    React.useEffect(() => {
        for (const input of JSON.parse(versionsKey) as MachineResourceKey[]) {
            if (input.expectedAccountId) machineResourceStore.daemonStateChanged(input, input.daemonStateVersion);
        }
    }, [versionsKey]);

    React.useEffect(() => {
        const releases = identities.filter(target => target.enabled).map(target => {
            const release = machineResourceStore.demand({ ...target.key, view: options.detail });
            const retirement = target.accountBinding!.onRetire(release);
            return () => { retirement.dispose(); release(); };
        });
        return () => { for (const release of releases) release(); };
    }, [identities, options.detail]);
}
