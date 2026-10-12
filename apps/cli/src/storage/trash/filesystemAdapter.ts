import { storagePathDirname as dirname } from '../storagePath';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { prepareHappierTempDirOwnerCleanup } from '@happier-dev/cli-common/tempDirs';
import { readStoragePathIdentity, removeStoragePath } from './removeStoragePath';
import { renameStoragePathNoReplace } from './renameStoragePath';

/** Generic bytes lifecycle used by the catalog; managed owners retain their own adapters. */
export function createStorageFilesystemAdapter(input: Readonly<{
    sourcePath: string; allowedRoot: string; ownerData?: JsonValue;
}>) {
    return {
        ownerData: input.ownerData ?? { sourcePath: input.sourcePath }, restorable: true,
        async retire({ payloadPath, beforeEffect }: Readonly<{ payloadPath: string; beforeEffect?: () => Promise<void> }>) {
            const cleanupMarker = prepareHappierTempDirOwnerCleanup(input.sourcePath);
            let expectedIdentity;
            try { expectedIdentity = await readStoragePathIdentity(input.sourcePath); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                await readStoragePathIdentity(payloadPath); await beforeEffect?.(); await cleanupMarker(); return;
            }
            await beforeEffect?.(); await renameStoragePathNoReplace(input.sourcePath, payloadPath, undefined, expectedIdentity);
            await cleanupMarker();
        },
        async reinstate({ payloadPath, restorePath, beforeEffect }: Readonly<{ payloadPath: string; restorePath: string; beforeEffect?: () => Promise<void> }>) {
            let expectedIdentity;
            try { expectedIdentity = await readStoragePathIdentity(payloadPath); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                // Trash reconciliation proves the original target identity in beforeEffect.
                await beforeEffect?.(); await readStoragePathIdentity(restorePath); return;
            }
            await beforeEffect?.(); await renameStoragePathNoReplace(payloadPath, restorePath, undefined, expectedIdentity);
        },
        async discard(options: Readonly<{ payloadPath?: string; beforeEffect?: () => Promise<void> }> = {}) {
            const path = options.payloadPath ?? input.sourcePath;
            const cleanupMarker = prepareHappierTempDirOwnerCleanup(path);
            let expectedIdentity;
            try { expectedIdentity = await readStoragePathIdentity(path); }
            catch (error) {
                if (!options.payloadPath || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                await options.beforeEffect?.(); return;
            }
            await removeStoragePath(path, { allowedRoot: options.payloadPath ? dirname(options.payloadPath) : input.allowedRoot,
                expectedIdentity, beforeEffect: options.beforeEffect });
            await cleanupMarker();
        },
    };
}
