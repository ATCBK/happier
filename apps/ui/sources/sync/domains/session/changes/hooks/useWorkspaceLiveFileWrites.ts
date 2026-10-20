import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { LiveFileWrite } from '../derivation/deriveLiveFileWrites';
import { useFileWriteSessionSnapshots } from './fileWriteSessionSnapshots';
import { useLiveFileWritesFromSessionSnapshots } from './useSessionLiveFileWrites';

export function useWorkspaceLiveFileWrites(scope: WorkspaceScopeBase | null): ReadonlyMap<string, LiveFileWrite> {
    return useLiveFileWritesFromSessionSnapshots(useFileWriteSessionSnapshots({ scope }), scope?.rootPath ?? null);
}
