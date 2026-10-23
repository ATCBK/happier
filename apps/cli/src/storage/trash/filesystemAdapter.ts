import { storagePathDirname as dirname } from '../storagePath';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { getHappierTempDirOwnerPath, prepareHappierTempDirOwnerCleanup, readHappierTempDirOwner } from '@happier-dev/cli-common/tempDirs';
import { readStoragePathIdentity, removeStoragePath } from './removeStoragePath';
import { renameStoragePathNoReplace } from './renameStoragePath';

/** Generic bytes lifecycle used by the catalog; managed owners retain their own adapters. */
export function createStorageFilesystemAdapter(input: Readonly<{
    sourcePath: string; allowedRoot: string; ownerData?: JsonValue;
}>) {
    return {
        ownerData: input.ownerData ?? { sourcePath: input.sourcePath }, restorable: true,
        async retire({ payloadPath, beforeEffect }: Readonly<{ payloadPath: string; beforeEffect?: () => Promise<void> }>) {
            // Preserve the exact sibling witness inside the existing Trash entry.
            // The temp owner still validates custody and replacement identity.
            const cleanupMarker = prepareHappierTempDirOwnerCleanup(input.sourcePath, undefined,
                (markerPath, identity) => renameStoragePathNoReplace(markerPath, getHappierTempDirOwnerPath(payloadPath), undefined, identity));
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
            const restoreMarker = async () => {
                if (!readHappierTempDirOwner(payloadPath)) return;
                const markerPath = getHappierTempDirOwnerPath(payloadPath);
                const identity = await readStoragePathIdentity(markerPath);
                await renameStoragePathNoReplace(markerPath, getHappierTempDirOwnerPath(restorePath), undefined, identity);
            };
            let expectedIdentity;
            try { expectedIdentity = await readStoragePathIdentity(payloadPath); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                // Trash reconciliation proves the original target identity in beforeEffect.
                await beforeEffect?.(); await readStoragePathIdentity(restorePath); await restoreMarker(); return;
            }
            await beforeEffect?.(); await renameStoragePathNoReplace(payloadPath, restorePath, undefined, expectedIdentity);
            await restoreMarker();
        },
        async discard(options: Readonly<{ payloadPath?: string; beforeEffect?: () => Promise<void> }> = {}) {
            const path = options.payloadPath ?? input.sourcePath;
            const cleanupMarker = prepareHappierTempDirOwnerCleanup(path);
            const markerPath = getHappierTempDirOwnerPath(path);
            const retainedMarker = options.payloadPath && readHappierTempDirOwner(path)
                ? await readStoragePathIdentity(markerPath) : undefined;
            const discardRetainedMarker = async () => {
                if (retainedMarker) await removeStoragePath(markerPath, { allowedRoot: dirname(path), expectedIdentity: retainedMarker });
            };
            let expectedIdentity;
            try { expectedIdentity = await readStoragePathIdentity(path); }
            catch (error) {
                if (!options.payloadPath || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                await options.beforeEffect?.(); await discardRetainedMarker(); return;
            }
            await removeStoragePath(path, { allowedRoot: options.payloadPath ? dirname(options.payloadPath) : input.allowedRoot,
                expectedIdentity, beforeEffect: options.beforeEffect });
            await cleanupMarker();
            await discardRetainedMarker();
        },
    };
}
