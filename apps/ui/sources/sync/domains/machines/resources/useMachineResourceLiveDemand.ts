import * as React from 'react';
import { useMachineDaemonReadIdentities } from '../useMachineDaemonReadTarget';
import { machineResourceStore } from './machineResourceStore';
import type { MachineResourceKey, MachineVitalsView } from './machineRpc';

/** Mounted visible surfaces own demand; passive row readers never start an RPC. */
export function useMachineResourceLiveDemand(machineKeys: readonly MachineResourceKey[], options: Readonly<{ detail: MachineVitalsView; enabled?: boolean }>): void {
    const identities = useMachineDaemonReadIdentities(machineKeys.map(input => ({ ...input, enabled: options.enabled })));
    const versionsKey = JSON.stringify(machineKeys.map(input => input.daemonStateVersion ?? null));

    React.useEffect(() => {
        const versions = JSON.parse(versionsKey) as Array<number | null>;
        identities.forEach((target, index) => {
            if (target.key.expectedAccountId) machineResourceStore.daemonStateChanged(target.key, versions[index]);
        });
    }, [identities, versionsKey]);

    React.useEffect(() => {
        const releases = identities.filter(target => target.enabled).map(target => {
            const release = machineResourceStore.demand({ ...target.key, view: options.detail });
            const retirement = target.accountBinding!.onRetire(release);
            return () => { retirement.dispose(); release(); };
        });
        return () => { for (const release of releases) release(); };
    }, [identities, options.detail]);
}
