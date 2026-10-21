import { sessionAddressKey } from '../sessionAddress';
import { normalizeSessionListKeyParts, type NormalizedSessionListKeyParts } from '../listing/sessionListKeyNormalization';

/**
 * `serverId` is nullable because the canonical folder record is
 * (`SessionFolderWorkspaceRefV1`, `serverId: string | null`): a folder authored
 * before a Home is resolved carries no server. The null form keys exactly like
 * the sibling assignment key below so both speak one convention.
 */
export type SessionFolderAddress = Readonly<{ serverId: string | null | undefined; folderId: string }>;

export function sessionFolderAddressKey(address: SessionFolderAddress): string {
    const normalizedServerId = typeof address.serverId === 'string' ? address.serverId.trim() : '';
    return JSON.stringify([normalizedServerId ? normalizedServerId : null, address.folderId.trim()]);
}

export function buildSessionFolderAssignmentKey(serverId: string | null | undefined, sessionId: string, keyParts?: NormalizedSessionListKeyParts): string {
    const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
    const normalizedSessionId = sessionId.trim();
    return normalizedServerId
        ? normalizeSessionListKeyParts(normalizedServerId, normalizedSessionId, keyParts).sessionKey
            ?? sessionAddressKey({ serverId: normalizedServerId, sessionId: normalizedSessionId })
        : JSON.stringify([null, normalizedSessionId]);
}
