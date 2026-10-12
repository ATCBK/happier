import { LocalServiceInventorySnapshotV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';
import type { LocalServiceInventorySnapshotV1 } from '@happier-dev/protocol/local/services/inventory/v1';
import type { NormalizedLocalServiceInventorySnapshot } from './scanner';

/** The guard's connection observations stay private on every Inventory V1 egress. */
export function projectLocalServiceInventorySnapshotV1(
    snapshot: NormalizedLocalServiceInventorySnapshot,
): LocalServiceInventorySnapshotV1 {
    return LocalServiceInventorySnapshotV1Schema.parse({
        ...snapshot,
        entries: snapshot.entries.map(({ establishedConnections: _internalConnectionFact, ...entry }) => entry),
    });
}
