import type { Tx } from '@/storage/inTx';
import { getDbProviderFromEnv } from '@/storage/prisma';

/**
 * Serializes activation decisions after Account content admission and before
 * reading mutable state. SQLite's Account admission already owns its writer.
 * Lifecycle CAS updates take this same row lock through their UPDATE.
 */
export async function acquireRunnerActivationLockInTx(tx: Tx, activationId: string): Promise<void> {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return;
    await tx.$queryRawUnsafe(
        provider === 'mysql'
            ? 'SELECT `id` FROM `EphemeralRunnerActivation` WHERE `id` = ? FOR UPDATE'
            : 'SELECT "id" FROM "EphemeralRunnerActivation" WHERE "id" = $1 FOR NO KEY UPDATE',
        activationId,
    );
}
