import { resolveTranscriptSessionBoardItemReferenceV1, type TranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export type { TranscriptSessionBoardItemReferenceV1 as TranscriptSessionBoardItemReference } from '@happier-dev/protocol/sessions/board';

/** Supplies the existing profile authority; acknowledgement recognition remains Protocol-owned. */
export function resolveTranscriptSessionBoardItemReference(input: Parameters<typeof resolveTranscriptSessionBoardItemReferenceV1>[0]): TranscriptSessionBoardItemReferenceV1 | null {
    return resolveTranscriptSessionBoardItemReferenceV1({ ...input, resolveServerScopeId: resolveServerProfileScopeIdForIdentifier });
}
