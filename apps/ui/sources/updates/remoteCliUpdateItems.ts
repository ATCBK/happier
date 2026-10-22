import type { MachineCapabilitiesSnapshot } from '@/hooks/server/useMachineCapabilitiesCache';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { resolveFleetMachineAvailability } from '@/sync/domains/machines/administration/fleetUnion';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

import { buildRemoteCliUpdateItem } from './items/buildMachineUpdateItems';
import type { UpdateItem } from './items/updateItem';
import { readRemoteCliUpdateAdvertised } from './machineCapabilitySnapshots';
import { observeMachineUpdateRun, signatureOfLastUpdate } from './machineUpdateRuns';
import type { useMachineUpdateRuns } from './machineUpdateRuns';

export type RemoteMachineUpdateFacts = Readonly<{
    machine: Machine;
    name: string;
    online: boolean | null;
    cliItem: UpdateItem;
    lastUpdateSignature: string;
}>;

/**
 * Every other machine's Happier CLI row, from machine metadata alone (K5 `cliUpdate`, else the
 * `happyCliVersion` every released daemon writes) — no RPC, so the always-mounted summary and the
 * open surface both use it. Remote Update is offered only when the machine says it can update itself
 * (`canUpdateRemotely`) AND its daemon lists `cli.update.v1` among its `tool.systemTasks` kinds.
 */
export function buildRemoteMachineUpdateFacts(
    machines: readonly Machine[],
    thisMachineId: string | null,
    runs: ReturnType<typeof useMachineUpdateRuns>,
    /** Cached capability detects (never fetched here) — the `tool.systemTasks` kinds live there. */
    snapshots: ReadonlyMap<string, MachineCapabilitiesSnapshot | null>,
    accountScope: ServerAccountScope | null,
): RemoteMachineUpdateFacts[] {
    const result: RemoteMachineUpdateFacts[] = [];
    // The one owner of names shown together: two machines that share a name get "· f98b".
    const names = resolveMachineDisplayNames(machines);
    for (const machine of machines) {
        if (machine.id === thisMachineId || !machine.metadata) continue;
        const facts = machine.metadata.cliUpdate ?? null;
        const availability = resolveFleetMachineAvailability(accountScope, machine);
        const online = availability === 'unknown' ? null : availability === 'online';
        const lastUpdateSignature = signatureOfLastUpdate(facts?.lastUpdate ?? null);
        const cliItem = buildRemoteCliUpdateItem({
            machineId: machine.id,
            title: t('updates.happierCliTitle'),
            online,
            platform: machine.metadata.platform ?? null,
            happyCliVersion: machine.metadata.happyCliVersion || null,
            facts,
            // K5: the machine's own fact, and the daemon's kinds once a detect has been cached
            // (`null` = not read yet; a daemon with K5 facts lists the kind exactly when it can).
            remoteUpdateAdvertised: facts?.canUpdateRemotely === true
                ? readRemoteCliUpdateAdvertised(snapshots.get(machine.id) ?? null)
                : false,
            task: observeMachineUpdateRun(runs, `${machine.id}:happier-cli`, { lastUpdateSignature }),
        });
        result.push({ machine, name: names.get(machine.id) ?? machine.id, online, cliItem, lastUpdateSignature });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}
