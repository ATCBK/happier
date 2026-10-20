import { z } from 'zod/mini';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

const SnapshotSchema = z.strictObject({ items: z.array(MachineAgentInventoryItemSchema), lastCheckedAt: z.number().check(z.nonnegative()) });
export type PersistedMachineAgentInventory = z.infer<typeof SnapshotSchema>;
export type MachineAgentInventoryStorage = Readonly<{ getString(key: string): string | undefined; set(key: string, value: string): void }>;

export function createMachineAgentInventoryPersistence(storage: MachineAgentInventoryStorage) {
    const key = (scope: ServerAccountScope, machineId: string) => serverAccountScopedStorageKey(`machine-agents:v1:${JSON.stringify(machineId)}`, scope);
    return {
        read(scope: ServerAccountScope, machineId: string): PersistedMachineAgentInventory | null {
            const raw = storage.getString(key(scope, machineId));
            if (!raw) return null;
            try {
                const parsed = SnapshotSchema.safeParse(JSON.parse(raw) as unknown);
                return parsed.success ? parsed.data : null;
            } catch { return null; }
        },
        write(scope: ServerAccountScope, machineId: string, snapshot: PersistedMachineAgentInventory): void {
            storage.set(key(scope, machineId), JSON.stringify(snapshot));
        },
    };
}
