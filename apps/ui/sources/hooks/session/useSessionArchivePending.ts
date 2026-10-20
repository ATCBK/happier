import { getStorage } from '@/sync/domains/state/storageStore';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { readSessionArchivePending } from '@/sync/domains/session/listing/sessionArchiveState';

/** Subscribe only to the pending bit for this exact Home-qualified Session. */
export function useSessionArchivePending(address: SessionAddress | null): boolean {
    return getStorage()(state => address ? readSessionArchivePending(state, address) : false);
}
