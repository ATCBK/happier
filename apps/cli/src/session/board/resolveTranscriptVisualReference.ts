import { resolveTranscriptSessionBoardItemReferenceV1, type TranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board/transcriptReference';
import { SessionBoardMutationActionResultV1Schema } from '@happier-dev/protocol/sessions/board/actions';
import { readHappierActionToolResultCandidates } from '@happier-dev/protocol/actions/happierActionToolResult';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';

/** CLI profile binding only; Protocol owns acknowledgement recognition and correspondence. */
export async function resolveTranscriptVisualReference(input: Parameters<typeof resolveTranscriptSessionBoardItemReferenceV1>[0]): Promise<TranscriptSessionBoardItemReferenceV1 | null> {
    const exact = resolveTranscriptSessionBoardItemReferenceV1(input);
    if (exact || !input.address || input.state !== 'completed') return exact;
    // Pending, invalid and ordinary non-visual output never reads the profile store.
    const hasAcknowledgement = readHappierActionToolResultCandidates(input.result, input.input).some(candidate => {
        const result = SessionBoardMutationActionResultV1Schema.safeParse(candidate);
        return result.success && result.data.result.operation === 'upsert_item';
    });
    if (!hasAcknowledgement) return null;
    const homeIdentity = await resolveServerProfileHomeIdentityId(input.address.serverId);
    return homeIdentity ? resolveTranscriptSessionBoardItemReferenceV1({ ...input,
        address: { ...input.address, serverId: homeIdentity } }) : null;
}
