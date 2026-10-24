import { describe, expect, it } from 'vitest';
import { createToolCallMessageFixture } from '@/dev/testkit';
import { resolveTranscriptSessionBoardItemReferenceV1 } from '@happier-dev/protocol/sessions/board';
import { isToolCallMessageGroupableInTranscript } from './isToolCallMessageGroupableInTranscript';
import { buildChatListItems } from '@/components/sessions/chatListItems';
import { buildTranscriptTurns } from '@/components/sessions/transcript/turnGrouping/buildTranscriptTurns';

describe('transcript tool group admission', () => {
    it('keeps an unanswered permission outside disclosure without excluding ordinary tools', () => {
        const ordinary = createToolCallMessageFixture();
        const approval = createToolCallMessageFixture({ tool: { ...ordinary.tool,
            permission: { id: 'approval', status: 'pending', kind: 'permission' },
        } });
        expect(isToolCallMessageGroupableInTranscript(ordinary)).toBe(true);
        expect(isToolCallMessageGroupableInTranscript(approval)).toBe(false);
    });

    it.each(['running', 'completed', 'error'] as const)('keeps a %s review standalone in linear and turn layouts while ordinary runs remain grouped', (state) => {
        const base = createToolCallMessageFixture();
        const ordinary = (id: string, createdAt: number) => createToolCallMessageFixture({ id, createdAt,
            tool: { ...base.tool, name: 'SubAgentRun', input: { runId: id, intent: 'delegate' } } });
        const review = createToolCallMessageFixture({ id: 'review', createdAt: 3,
            tool: { ...base.tool, name: 'SubAgentRun', state, input: { runId: 'review-run', intent: 'review' } } });
        const messages = [ordinary('before-1', 1), ordinary('before-2', 2), review,
            ordinary('after-1', 4), ordinary('after-2', 5)];
        const input = { messageIdsOldestFirst: messages.map((message) => message.id),
            messagesById: Object.fromEntries(messages.map((message) => [message.id, message])) };

        const linear = buildChatListItems({ ...input, pendingMessages: [], groupConsecutiveToolCalls: true });
        expect(linear.map((item) => item.kind === 'tool-calls-group' ? item.toolMessageIds
            : item.kind === 'message' ? item.messageId : item.kind)).toEqual([
            ['before-1', 'before-2'], 'review', ['after-1', 'after-2'],
        ]);
        for (const strategy of ['consecutive_tools', 'all_tools_in_turn'] as const) {
            const turns = buildTranscriptTurns({ ...input, groupToolCalls: true, toolCallsGroupStrategy: strategy });
            expect(turns.flatMap((turn) => turn.content.map((item) => item.kind === 'tool_calls'
                ? item.toolMessageIds : item.messageId))).toEqual(strategy === 'consecutive_tools'
                ? [['before-1', 'before-2'], 'review', ['after-1', 'after-2']]
                : [['before-1', 'before-2', 'after-1', 'after-2'], 'review']);
        }
    });
});

describe('transcript visual replies', () => {
    const visualCall = (itemDestination: 'transcript' | 'board' | 'both', state = 'completed') => {
        const base = createToolCallMessageFixture();
        const input = { itemId: 'chart', expectedItemRevision: null, destination: itemDestination,
            ...(itemDestination === 'transcript' ? {} : { placement: {} }),
            item: { v: 1, title: 'Chart', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
                source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Chart' } } } } };
        const result = { v: 1, serverId: 'home', sessionId: 'session', itemDestination,
            destination: itemDestination === 'transcript' ? null : { tabId: 'main', width: 'full' },
            result: { operation: 'upsert_item', itemId: 'chart', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', outcome: 'created',
                ...(itemDestination === 'transcript' ? {} : { layoutRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAg' }) } };
        return createToolCallMessageFixture({ tool: { ...base.tool, name: 'session_board_item_upsert', state, input, result } as typeof base.tool });
    };

    it('stands a call that answered with a transcript visual on its own, so the visual is the reply and not group content', () => {
        expect(isToolCallMessageGroupableInTranscript(visualCall('transcript'))).toBe(false);
        expect(isToolCallMessageGroupableInTranscript(visualCall('both'))).toBe(false);
    });

    it('keeps Board-only and unfinished visual calls in the ordinary tool group', () => {
        const board = visualCall('board');
        // The Board-only call is a real acknowledgement, so it stays grouped for its destination, not for a bad shape.
        expect(resolveTranscriptSessionBoardItemReferenceV1({ toolName: board.tool.name, state: board.tool.state, input: board.tool.input,
            result: board.tool.result, address: { serverId: 'home', sessionId: 'session' } })?.itemDestination).toBe('board');
        expect(isToolCallMessageGroupableInTranscript(board)).toBe(true);
        expect(isToolCallMessageGroupableInTranscript(visualCall('transcript', 'running'))).toBe(true);
    });
});

describe('Ask record rows', () => {
    const sendCall = (name: string, actionId: string | null) => {
        const base = createToolCallMessageFixture();
        return createToolCallMessageFixture({ tool: { ...base.tool, name,
            input: actionId ? { actionId, input: { sessionId: 'receiver', message: 'Question', reply: 'wait' } } : { sessionId: 'receiver' },
            result: { ok: true, result: { status: 'accepted', localId: 'request' } } } });
    };

    it('stands an agent’s message send on its own, so who it asked and how it ended stay visible, and groups other Actions', () => {
        expect(isToolCallMessageGroupableInTranscript(sendCall('mcp__happier__action_execute', 'session.message.send'))).toBe(false);
        expect(isToolCallMessageGroupableInTranscript(sendCall('mcp__happier__action_execute', 'session.status.get'))).toBe(true);
        expect(isToolCallMessageGroupableInTranscript(sendCall('exec', null))).toBe(true);
    });
});
