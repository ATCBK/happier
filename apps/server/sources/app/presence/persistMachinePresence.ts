import type { TransactionClient } from '@/storage/db';

/** Presence batches may settle after a newer heartbeat or daemon publication. */
export async function persistMachinePresence(
    tx: Pick<TransactionClient, 'machine'>,
    presence: Readonly<{ accountId: string; machineId: string; timestamp: number }>,
): Promise<void> {
    const lastActiveAt = new Date(presence.timestamp);
    await tx.machine.updateMany({
        where: {
            accountId: presence.accountId,
            id: presence.machineId,
            revokedAt: null,
            replacedByMachineId: null,
            lastActiveAt: { lte: lastActiveAt },
        },
        data: { lastActiveAt, active: true },
    });
}
