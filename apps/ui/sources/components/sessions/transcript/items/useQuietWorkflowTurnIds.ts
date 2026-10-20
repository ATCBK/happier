import * as React from 'react';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { useShallow } from 'zustand/react/shallow';
import type { Message } from '@happier-dev/session-core/messages';
import { getStorage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import type { ChatTranscriptListItem } from '../chatListTypes';
import { readWorkflowTurnProvenance } from '../turnGrouping/workflowTranscriptTurns';

/**
 * Turns kept whole as one row: producer-observed quiet workflow turns and trigger-run folds.
 * Exact invocation subscriptions: unrelated Run traffic never rebuilds the transcript.
 */
export function useQuietWorkflowTurnIds(items: readonly ChatTranscriptListItem[], getMessageById: (id: string) => Message | null,
    reveal?: Readonly<{ findActive: boolean; jumpToSeq: number | null | undefined }>) {
    const source = useSessionTranscriptSource();
    // Existing find/pin/deep-link navigation must be able to reveal a reply, not land inside a hidden body.
    const revealsTurn = React.useCallback((turn: Extract<ChatTranscriptListItem, { kind: 'turn' }>['turn']) => {
        if (reveal?.findActive) return true;
        if (reveal?.jumpToSeq == null) return false;
        const messageIds = [...(turn.userMessageId ? [turn.userMessageId] : []), ...turn.content.flatMap((content) => content.kind === 'message'
            ? [content.messageId] : content.toolMessageIds)];
        return messageIds.some((id) => getMessageById(id)?.seq === reveal.jumpToSeq);
    }, [getMessageById, reveal?.findActive, reveal?.jumpToSeq]);
    const references = React.useMemo(() => items.flatMap((item) => {
        if (item.kind !== 'turn' || !item.turn.userMessageId) return [];
        const provenance = readWorkflowTurnProvenance(getMessageById(item.turn.userMessageId));
        if (!provenance || revealsTurn(item.turn)) return [];
        return [{ turnId: item.id, runId: provenance.runId, invocationRecordId: provenance.invocationRecordId }];
    }), [items, getMessageById, revealsTurn]);
    // A trigger run's fold is always one row; only navigation into its turns opens it into ordinary rows.
    const runFoldIds = React.useMemo(() => items.flatMap((item) => (
        item.kind === 'turn' && item.workflowRun && !revealsTurn(item.turn) ? [item.id] : []
    )).join('\u0000'), [items, revealsTurn]);
    const ids = getStorage()(useShallow((state) => {
        // Static/public or another Home's transcript must not consume private Account facts.
        if (source.kind !== 'app' || (source.serverId && (!state.profileScope
            || !areServerProfileIdentifiersEquivalent(state.profileScope.serverId, source.serverId)))) return [];
        return references.flatMap((reference) => state.workflowRunInvocationsByRunId[workflowRunStoreKey(reference.runId)]
            ?.factsById[reference.invocationRecordId]?.notificationCondition === 'suppressed' ? [reference.turnId] : []);
    }));
    return React.useMemo(() => new Set(runFoldIds ? [...ids, ...runFoldIds.split('\u0000')] : ids), [ids, runFoldIds]);
}
