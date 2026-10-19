import type { SessionDraftDocumentV2 } from '@happier-dev/protocol/drafts/sessionDraftsV2';

type ComposerDraftDocument = Extract<SessionDraftDocumentV2, { composer: unknown }>;

/** Preserve absent-snapshot assertions while requiring a real Composer document when present. */
export function requireComposerDraftDocument(document: SessionDraftDocumentV2): ComposerDraftDocument;
export function requireComposerDraftDocument(document: SessionDraftDocumentV2 | undefined): ComposerDraftDocument | undefined;
export function requireComposerDraftDocument(document: SessionDraftDocumentV2 | undefined): ComposerDraftDocument | undefined {
    if (!document) return undefined;
    if (!('composer' in document)) throw new Error('Expected a Composer draft document');
    return document;
}
