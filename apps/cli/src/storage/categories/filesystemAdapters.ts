import { z } from 'zod';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { createStorageFilesystemAdapter } from '../trash/filesystemAdapter';
import { storagePathDirname as dirname, storagePathsEqual, storagePathContains } from '../storagePath';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { StorageCategoryDefinition, StorageCleanupItem } from './types';
import { StorageCategoryAdapterError } from './types';

export const FilesystemOwnerDataSchema = z.object({
    kind: z.literal('filesystem'), sourcePath: z.string().min(1), allowedRoot: z.string().min(1),
    sessionId: z.string().min(1).optional(),
}).strict();
const FilesystemOwnerDataStoredReadSchema = createStoredReadSchema(FilesystemOwnerDataSchema);
export function bindFilesystemItem(item: StorageCleanupItem) {
    const binding = item.sessionId ? { sessionId: item.sessionId } : {};
    return { ...createStorageFilesystemAdapter({ sourcePath: item.path, allowedRoot: dirname(item.path),
        ownerData: normalizeStrictJsonValue({ kind: 'filesystem', sourcePath: item.path, allowedRoot: dirname(item.path), ...binding }) }), ...binding };
}
export function filesystemAdapterForEntry(data: JsonValue) {
    const parsed = FilesystemOwnerDataStoredReadSchema.safeParse(data);
    if (!parsed.success || storagePathsEqual(parsed.data.allowedRoot, parsed.data.sourcePath)
        || !storagePathContains(parsed.data.allowedRoot, parsed.data.sourcePath)) {
        throw new StorageCategoryAdapterError('owner_data_invalid');
    }
    return { ...createStorageFilesystemAdapter({ ...parsed.data, ownerData: normalizeStrictJsonValue(parsed.data) }),
        ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}) };
}
export const filesystemCategoryAdapters: Pick<StorageCategoryDefinition, 'bindAdapter' | 'adapterForEntry'> = {
    async bindAdapter(item) { return bindFilesystemItem(item); },
    async adapterForEntry(data) { return filesystemAdapterForEntry(data); },
};
