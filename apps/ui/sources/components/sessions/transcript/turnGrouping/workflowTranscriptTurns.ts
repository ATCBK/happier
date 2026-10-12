import type { Message } from '@happier-dev/session-core/messages';
import { readSessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { ChatListItem } from '@/components/sessions/chatListItems';
import type { TranscriptTurn } from './buildTranscriptTurns';

export type WorkflowTranscriptTurnItem = {
    kind: 'turn';
    id: string;
    turn: TranscriptTurn;
    /** Original linear rows, retained verbatim when quiet evidence does not admit a fold. */
    linearItems?: readonly ChatListItem[];
};

export function readWorkflowTurnProvenance(message: Message | null | undefined) {
    const provenance = message?.kind === 'user-text' ? readSessionMessageProvenance(message.meta) : null;
    return provenance?.kind === 'workflow_invocation' ? provenance : null;
}

/** Use the canonical turn builder's membership in linear mode too, never regroup across fork boundaries. */
export function groupWorkflowTranscriptTurns(
    items: readonly ChatListItem[],
    turns: readonly TranscriptTurn[],
    getMessageById: (id: string) => Message | null,
): Array<ChatListItem | WorkflowTranscriptTurnItem> {
    const byMessageId = new Map<string, TranscriptTurn>();
    for (const turn of turns) {
        if (!turn.userMessageId || !readWorkflowTurnProvenance(getMessageById(turn.userMessageId))) continue;
        byMessageId.set(turn.userMessageId, turn);
        for (const content of turn.content) {
            for (const id of content.kind === 'message' ? [content.messageId] : content.toolMessageIds) {
                byMessageId.set(id, turn);
            }
        }
    }
    const emitted = new Map<string, ChatListItem[]>();
    const output: Array<ChatListItem | WorkflowTranscriptTurnItem> = [];
    for (const item of items) {
        const turn = item.kind === 'message' ? byMessageId.get(item.messageId)
            : item.kind === 'tool-calls-group' ? byMessageId.get(item.toolMessageIds[0] ?? '') : undefined;
        if (!turn) { output.push(item); continue; }
        const linearItems = emitted.get(turn.id);
        if (linearItems) { linearItems.push(item); continue; }
        const span = [item];
        emitted.set(turn.id, span);
        output.push({ kind: 'turn', id: turn.id, turn, linearItems: span });
    }
    return output;
}
