import { readSessionRoleIdV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';

import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { storage } from '@/sync/domains/state/storageStore';

/** Sessions (not archived) that currently carry this role; a number, so only a change re-renders the reader. */
export function selectRoleSessionCount(state: ReturnType<typeof storage.getState>, roleId: string): number {
    let count = 0;
    for (const session of Object.values(state.sessions)) {
        if (!session || session.archivedAt) continue;
        if (readSessionRoleIdV1(readSessionOwnerMetadataView(session)) === roleId) count += 1;
    }
    return count;
}

export function useRoleSessionCount(roleId: string): number {
    return storage((state) => selectRoleSessionCount(state, roleId));
}
