import type { StorageItemRefV1 } from '@happier-dev/protocol/storage/storageV1';

/**
 * The served reference a collect or check sends: only the item's id and path. The machine reads the
 * item's identity and records who collected it when it accepts the delta, and returns those in its own
 * pile refs; a client never supplies them. Accepts anything that names an item (a served item, a
 * daemon-resolved pile ref, a disk node row) and keeps only the reference.
 */
export function toStorageItemRef(item: Readonly<StorageItemRefV1>): StorageItemRefV1 {
    return { itemId: item.itemId, path: item.path };
}
