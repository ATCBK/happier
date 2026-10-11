import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { buildChatListItems } from '@/components/sessions/chatListItems';
import { buildTranscriptTurnsCached } from './buildTranscriptTurns';
import { buildTranscriptTurnUnits } from './buildTranscriptTurnUnits';
import { groupWorkflowTranscriptTurns } from './workflowTranscriptTurns';

describe('workflow turn membership in linear transcripts', () => {
    it('folds the same canonical span in either mode without absorbing a new user turn or fork ancestor', () => {
        const messages: Message[] = [
            { kind: 'user-text', id: 'habit', localId: null, text: 'Daily summary', createdAt: 1,
                meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: 'daily', invocationRecordId: 'step' } } },
            { kind: 'agent-text', id: 'reply', localId: null, text: 'Nothing to report', createdAt: 2 },
            { kind: 'agent-text', id: 'fork-child', localId: null, text: 'Child context', createdAt: 3 },
            { kind: 'user-text', id: 'human', localId: null, text: 'Check the release', createdAt: 4 },
            { kind: 'agent-text', id: 'human-reply', localId: null, text: 'Two things need you', createdAt: 5 },
        ];
        const messagesById = Object.fromEntries(messages.map((message) => [message.id, message]));
        const getMessageById = (id: string) => messagesById[id] ?? null;
        const messageIdsOldestFirst = messages.map((message) => message.id);
        const { turns } = buildTranscriptTurnsCached({ cache: null, messageIdsOldestFirst, messagesById,
            groupToolCalls: true, toolCallsGroupStrategy: 'consecutive_tools', forkBoundaryBeforeMessageIds: new Set(['fork-child']) });
        const linear = buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages: [] });
        const grouped = groupWorkflowTranscriptTurns(linear, turns, getMessageById);
        const decompose = (items: Parameters<typeof buildTranscriptTurnUnits>[0]['items'], quiet: boolean) => buildTranscriptTurnUnits({
            items, getMessageById, collapsedPreviewCount: 0, isGroupExpanded: () => false,
            quietWorkflowTurnIds: new Set(quiet ? [turns[0]!.id] : []),
        });
        const fromTurns = turns.map((turn) => ({ kind: 'turn' as const, id: turn.id, turn }));
        expect(decompose(grouped, true)).toEqual(decompose(fromTurns, true));
        expect(decompose(grouped, true).map((item) => item.kind)).toEqual(['turn', 'message', 'message', 'message']);
        expect(decompose(grouped, false).map((item) => item.id)).toEqual(linear.map((item) => item.id));
        expect(decompose(grouped, true)[0]).toMatchObject({ turn: { userMessageId: 'habit', content: [{ messageId: 'reply' }] } });
    });
});
