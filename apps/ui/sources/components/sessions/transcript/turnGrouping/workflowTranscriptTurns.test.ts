import { describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { buildChatListItems } from '@/components/sessions/chatListItems';
import { buildTranscriptTurnsCached } from './buildTranscriptTurns';
import { buildTranscriptTurnUnits } from './buildTranscriptTurnUnits';
import { groupWorkflowTranscriptTurns } from './workflowTranscriptTurns';

describe('workflow turn membership in linear transcripts', () => {
    it.each([false, true])('preserves unfolded interleaved linear rows with all-tools turn grouping (linear groups: %s)', groupToolCalls => {
        const tool = (id: string, createdAt: number): Message => ({ kind: 'tool-call', id, localId: null, createdAt,
            tool: { id: `call:${id}`, name: 'tool', state: 'completed', input: {}, result: {}, description: null,
                createdAt, startedAt: createdAt, completedAt: createdAt + 1 }, children: [] });
        const messages: Message[] = [
            { kind: 'user-text', id: 'workflow', localId: null, text: 'Daily summary', createdAt: 1,
                meta: { happierProvenanceV1: { v: 2, kind: 'workflow_invocation', runId: 'daily', invocationRecordId: 'step', retired: true } } },
            tool('t1', 2), tool('t1b', 3),
            { kind: 'agent-text', id: 'a1', localId: null, text: 'First reply', createdAt: 4 },
            tool('t2', 5),
            { kind: 'agent-text', id: 'a2', localId: null, text: 'Final reply', createdAt: 6 },
            { kind: 'user-text', id: 'human', localId: null, text: 'Next task', createdAt: 7 },
        ];
        const messagesById = Object.fromEntries(messages.map(message => [message.id, message]));
        const getMessageById = (id: string) => messagesById[id] ?? null;
        const messageIdsOldestFirst = messages.map(message => message.id);
        const { turns } = buildTranscriptTurnsCached({ cache: null, messageIdsOldestFirst, messagesById,
            groupToolCalls: true, toolCallsGroupStrategy: 'all_tools_in_turn' });
        const linear = buildChatListItems({ messageIdsOldestFirst, messagesById, pendingMessages: [],
            groupConsecutiveToolCalls: groupToolCalls });
        const grouped = groupWorkflowTranscriptTurns(linear, turns, getMessageById);
        const decompose = (items: Parameters<typeof buildTranscriptTurnUnits>[0]['items'], quietWorkflowTurnIds?: ReadonlySet<string>) =>
            buildTranscriptTurnUnits({ items, getMessageById, collapsedPreviewCount: 0, isGroupExpanded: () => true, quietWorkflowTurnIds });
        // No evidence, or matched evidence projected as an empty quiet set, must retain exactly the old rows.
        expect(decompose(grouped)).toEqual(decompose(linear));
        expect(decompose(grouped, new Set())).toEqual(decompose(linear));
        const folded = decompose(grouped, new Set([turns[0]!.id]));
        expect(folded.map(item => item.id)).toEqual([turns[0]!.id, 'msg:human']);
        expect(folded[0]).toMatchObject({ turn: turns[0] });
    });
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
        expect(decompose(grouped, true)).toMatchObject(decompose(fromTurns, true));
        expect(decompose(grouped, true).map((item) => item.kind)).toEqual(['turn', 'message', 'message', 'message']);
        expect(decompose(grouped, false).map((item) => item.id)).toEqual(linear.map((item) => item.id));
        expect(decompose(grouped, true)[0]).toMatchObject({ turn: { userMessageId: 'habit', content: [{ messageId: 'reply' }] } });
    });
});
