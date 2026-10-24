import type { StorageItemV1 } from '@happier-dev/protocol/storage/storageV1';

/** Shared default for resource proposals, pile sweeps and Review; explicit choices stay with the person. */
export function storageVerdictStartsTicked(verdict: StorageItemV1['verdict']): boolean {
    return verdict === 'safe';
}
