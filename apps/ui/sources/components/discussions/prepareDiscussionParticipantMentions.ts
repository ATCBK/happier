import type { DiscussionExecutableParticipantInviteOutcome } from '@/sync/api/discussions/discussionActions';
import type { DiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import type { DiscussionComposerValue } from './DiscussionComposer';
import type { useDiscussionParticipantManagement } from './useDiscussionParticipantManagement';
import { buildDiscussionContent, readDiscussionMentionParticipant } from './discussionComposerDocument';
import { parseComposerStructuredInputMentionsForText } from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

type Refusal = Exclude<DiscussionExecutableParticipantInviteOutcome, Readonly<{ kind: 'succeeded' }>>;
export type DiscussionParticipantMentionPreparation = Readonly<{ kind: 'ready'; content: ReturnType<typeof buildDiscussionContent> }>
    | Readonly<{ kind: 'refused'; outcome: Refusal }>;

/** Explicit Send only: resolve saved slots through their current ordinary invitation owner. */
export async function prepareDiscussionParticipantMentions(input: Readonly<{
    document: DiscussionComposerValue;
    discussionId: string;
    repository: DiscussionRepository;
    inviteExecutable: ReturnType<typeof useDiscussionParticipantManagement>['inviteExecutable'];
    isCurrent(): boolean;
}>): Promise<DiscussionParticipantMentionPreparation> {
    const refuse = (errorCode: string): DiscussionParticipantMentionPreparation => ({ kind: 'refused', outcome: { kind: 'failed', errorCode } });
    if (!input.isCurrent()) return refuse('canceled');
    const mentions = parseComposerStructuredInputMentionsForText(input.document.mentions, input.document.text).mentions;
    const slots = [...new Set(mentions.flatMap(mention => {
        const participant = readDiscussionMentionParticipant(mention);
        return participant?.kind === 'model' ? [participant.participantSlotId] : [];
    }))];
    if (slots.length === 0) return { kind: 'ready', content: buildDiscussionContent(input.document.text, mentions) };
    try {
        const roster = await input.repository.participants(input.discussionId);
        if (!input.isCurrent()) return refuse('canceled');
        if (roster.kind !== 'succeeded') return { kind: 'refused', outcome: roster };
        const sessions = new Map<string, string>();
        for (const slot of slots) {
            if (!input.isCurrent()) return refuse('canceled');
            const participant = roster.value.participants.find(row => row.participant.kind === 'model' && row.participant.participantSlotId === slot);
            if (!participant || !('launch' in participant)) return refuse('discussion_invalid_mention');
            if (participant.sessionId) { sessions.set(slot, participant.sessionId); continue; }
            const started = await input.inviteExecutable({ kind: 'model', launch: participant.launch }, {
                participantSlotId: slot, answerPolicy: participant.answerPolicy,
            });
            if (!input.isCurrent()) return refuse('canceled');
            if (!started) return { kind: 'refused', outcome: { kind: 'checking' } };
            if (started.kind !== 'succeeded') return { kind: 'refused', outcome: started };
            const bound = 'modelParticipant' in started.value ? started.value.modelParticipant : undefined;
            if (bound?.participant.participantSlotId !== slot || !bound.sessionId) return { kind: 'refused', outcome: { kind: 'checking' } };
            sessions.set(slot, bound.sessionId);
        }
        return { kind: 'ready', content: buildDiscussionContent(input.document.text, mentions, sessions) };
    } catch {
        return input.isCurrent() ? { kind: 'refused', outcome: { kind: 'checking' } } : refuse('canceled');
    }
}
