import type { AttachmentDraft } from './attachmentDraftModel';
import {
    clearAttachmentDraftsForKey,
    readAttachmentDraftsForKey,
    writeAttachmentDraftsForKey,
} from './attachmentDraftMemoryStore';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';

export type SessionAttachmentDraftScope = Readonly<{
    serverId: string;
    /** Exact signed-in Account that owns these process-local file bytes. */
    accountId: string;
    sessionId: string;
    /** Exact Run id or rowless/first-send occurrence that owns these local bytes. */
    occurrenceId: string;
}>;

export function sessionAttachmentDraftKey(scope: SessionAttachmentDraftScope): string {
    // Reuse the canonical Account and Session identity encoders. The occurrence
    // is an opaque Run/first-send identity, never parsed back out. File bytes
    // must never cross an Account switch even when Home, Session, and Run ids
    // happen to be identical.
    return `session-target:${JSON.stringify([
        serverAccountScopeKeySuffix(scope),
        sessionAddressKey(scope),
        scope.occurrenceId,
    ])}`;
}

export function readSessionAttachmentDrafts(scope: SessionAttachmentDraftScope): AttachmentDraft[] {
    return readAttachmentDraftsForKey(sessionAttachmentDraftKey(scope));
}

export function writeSessionAttachmentDrafts(scope: SessionAttachmentDraftScope, drafts: readonly AttachmentDraft[]): void {
    writeAttachmentDraftsForKey(sessionAttachmentDraftKey(scope), drafts);
}

export function clearSessionAttachmentDrafts(scope: SessionAttachmentDraftScope): void {
    clearAttachmentDraftsForKey(sessionAttachmentDraftKey(scope));
}
