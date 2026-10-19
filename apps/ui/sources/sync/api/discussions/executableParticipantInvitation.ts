import { DiscussionInviteInputV1Schema, type DiscussionActionInputV1ById } from '@happier-dev/protocol/discussions/actions';
import { normalizeExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';
import type { DiscussionAnswerPolicyV1 } from '@happier-dev/protocol/discussions/participants';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type DiscussionExecutableParticipantInviteInput = Readonly<{
    discussionId: string;
    selection: unknown;
    /** Retained by the invitation draft and passed unchanged on every explicit retry. */
    participantSlotId?: string;
    answerPolicy?: DiscussionAnswerPolicyV1;
}>;

/** Selection/preview allocates nothing; only the canonical invite Action may create a Session. */
export function prepareDiscussionExecutableParticipantInvitation(serverId: string, input: DiscussionExecutableParticipantInviteInput):
    | Readonly<{ kind: 'ready'; input: DiscussionActionInputV1ById['discussion.invite'] }>
    | Readonly<{ kind: 'failed'; errorCode: string }> {
    const selection = normalizeExecutableParticipantSelectionV1(input.selection);
    if (!selection) return { kind: 'failed', errorCode: 'invalid_input' };
    // Existing-Session wire input drops its qualifier; model admission retains
    // the launch target and belongs to the canonical Action executor.
    if (selection.kind === 'session' && !areServerProfileIdentifiersEquivalent(serverId, selection.session.serverId)) {
        return { kind: 'failed', errorCode: 'discussion_participant_home_mismatch' };
    }
    if (selection.kind === 'model' && !input.participantSlotId) {
        return { kind: 'failed', errorCode: 'discussion_participant_slot_required' };
    }
    if (selection.kind === 'session' && input.participantSlotId !== undefined) return { kind: 'failed', errorCode: 'invalid_input' };
    const parsed = DiscussionInviteInputV1Schema.safeParse({ discussionId: input.discussionId,
        participant: selection.kind === 'session' ? { kind: 'session', sessionId: selection.session.sessionId }
            : { kind: 'model', participantSlotId: input.participantSlotId, launch: selection.launch },
        ...(input.answerPolicy === undefined ? {} : { answerPolicy: input.answerPolicy }),
    });
    return parsed.success ? { kind: 'ready', input: parsed.data } : { kind: 'failed', errorCode: 'invalid_input' };
}
