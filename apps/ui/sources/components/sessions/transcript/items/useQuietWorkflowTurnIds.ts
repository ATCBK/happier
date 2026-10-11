import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Message } from '@happier-dev/session-core/messages';
import { getStorage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import type { ChatTranscriptListItem } from '../chatListTypes';
import { readWorkflowTurnProvenance } from '../turnGrouping/workflowTranscriptTurns';

/** Exact invocation subscriptions: unrelated Run traffic never rebuilds the transcript. */
export function useQuietWorkflowTurnIds(items: readonly ChatTranscriptListItem[], getMessageById: (id: string) => Message | null,
    reveal?: Readonly<{ findActive: boolean; jumpToSeq: number | null | undefined }>) {
    const source = useSessionTranscriptSource();
    const references = React.useMemo(() => items.flatMap((item) => {
        if (item.kind !== 'turn' || !item.turn.userMessageId) return [];
        const provenance = readWorkflowTurnProvenance(getMessageById(item.turn.userMessageId));
        if (!provenance || reveal?.findActive) return [];
        // Existing find/pin/deep-link navigation must be able to reveal a reply, not land inside a hidden body.
        if (reveal?.jumpToSeq != null) {
            const messageIds = [item.turn.userMessageId, ...item.turn.content.flatMap((content) => content.kind === 'message'
                ? [content.messageId] : content.toolMessageIds)];
            if (messageIds.some((id) => getMessageById(id)?.seq === reveal.jumpToSeq)) return [];
        }
        return [{ turnId: item.id, runId: provenance.runId, invocationRecordId: provenance.invocationRecordId }];
    }), [items, getMessageById, reveal?.findActive, reveal?.jumpToSeq]);
    const ids = getStorage()(useShallow((state) => {
        // Static/public or another Home's transcript must not consume private Account facts.
        if (source.kind !== 'app' || (source.serverId && (!state.profileScope
            || !areServerProfileIdentifiersEquivalent(state.profileScope.serverId, source.serverId)))) return [];
        return references.flatMap((reference) => state.workflowRunInvocationsByRunId[reference.runId]
            ?.factsById[reference.invocationRecordId]?.notificationCondition === 'suppressed' ? [reference.turnId] : []);
    }));
    return React.useMemo(() => new Set(ids), [ids]);
}
