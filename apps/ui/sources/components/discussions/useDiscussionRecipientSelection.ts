import * as React from 'react';
import type { DiscussionParticipantRefV1 } from '@happier-dev/protocol/discussions/references';
import type { DiscussionParticipantsListResponseV1 } from '@happier-dev/protocol/discussions/participants';
import { buildRecipientMultiSelectModel, type RecipientMultiSelectModel } from '@/components/sessions/agentInput/routing/recipientMultiSelectModel';
import type { DiscussionDraft } from './useDiscussionDraft';

export function discussionRecipientKey(participant: DiscussionParticipantRefV1): string {
    return participant.kind === 'account' ? `account:${participant.accountId}` : `session:${participant.sessionId}`;
}

/** A demanded, admitted roster supplies choices; display labels never admit a recipient. */
export function useDiscussionRecipientSelection(input: Readonly<{
    draft: Pick<DiscussionDraft, 'recipients' | 'setRecipients'>;
    roster: DiscussionParticipantsListResponseV1 | null;
    label(participant: DiscussionParticipantRefV1): string;
}>): RecipientMultiSelectModel<DiscussionParticipantRefV1> {
    return React.useMemo(() => {
        const participants = new Map<string, DiscussionParticipantRefV1>();
        const add = (participant: DiscussionParticipantRefV1) => participants.set(discussionRecipientKey(participant), participant);
        if (input.roster) {
            add({ kind: 'account', accountId: input.roster.ownerAccountId });
            for (const grant of input.roster.grants) if (grant.principal.kind === 'account') add(grant.principal);
            for (const row of input.roster.participants) {
                if (row.participant.kind === 'session') add(row.participant);
                else if ('sessionId' in row && row.sessionId) add({ kind: 'session', sessionId: row.sessionId });
            }
        }
        return buildRecipientMultiSelectModel({
            targets: [...participants].map(([id, recipient]) => ({ id, recipient, label: input.label(recipient) })),
            recipients: input.draft.recipients, key: discussionRecipientKey, onChange: input.draft.setRecipients,
        });
    }, [input.roster, input.label, input.draft.recipients, input.draft.setRecipients]);
}
