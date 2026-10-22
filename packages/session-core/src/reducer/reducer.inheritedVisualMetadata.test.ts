import { describe, expect, it } from 'vitest';
import { createReducer, reducer } from './reducer.js';
import { normalizeRawMessage } from '../raw/normalize.js';
import { applyReducedMessages, type OrderedTranscript } from '../transcript/orderedMessages.js';

describe('replayed tool metadata', () => {
    it('keeps admitted inherited tool correlation independent across original Sessions and Homes', () => {
        const state = createReducer();
        let transcript: OrderedTranscript = { messageIdsOldestFirst: [], messagesById: {} };
        let createdAt = 0;
        for (const [serverId, sessionId, itemId] of [
            ['home', 'grandparent', 'first'], ['home', 'parent', 'second'], ['other-home', 'parent', 'third'],
        ]) {
            for (const phase of ['tool-call', 'tool-result'] as const) {
                const id = `${itemId}-${phase}`;
                const data = phase === 'tool-call'
                    ? { type: phase, callId: 'reused-native-id', name: 'session_board_item_upsert', id, input: { itemId } }
                    : { type: phase, callId: 'reused-native-id', id, output: { itemId } };
                const message = normalizeRawMessage(id, null, ++createdAt, { role: 'agent', content: { type: 'acp', agentId: 'codex', data },
                    meta: { forkVisualOriginV1: { v: 1, serverId, sessionId, sourceMessageId: id, sourceSeq: phase === 'tool-call' ? 1 : 2 } } });
                if (!message) throw new Error('Invalid admitted tool fixture');
                transcript = applyReducedMessages(transcript, reducer(state, [message], null).messages);
            }
        }
        const messages = transcript.messageIdsOldestFirst.map(id => transcript.messagesById[id]);
        expect(messages).toHaveLength(3);
        expect(messages.map(message => message?.kind === 'tool-call' ? message.tool.result : null)).toEqual([
            { itemId: 'first' }, { itemId: 'second' }, { itemId: 'third' },
        ]);
        expect(new Set(messages.map(message => message?.kind === 'tool-call' ? message.tool.id : null)).size).toBe(3);
        expect(messages.map(message => message?.kind === 'tool-call' ? message.tool.sourceToolId : null)).toEqual([
            'reused-native-id', 'reused-native-id', 'reused-native-id',
        ]);
    });

    it('publishes imported presentation provenance when native tool identity already completed without changing the body', () => {
        const state = createReducer();
        const call = { role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
            type: 'tool-call', callId: 'visual', name: 'session_board_item_upsert', id: 'call', input: { itemId: 'graph' },
        } } };
        const result = { role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
            type: 'tool-result', callId: 'visual', id: 'result', output: { stable: 'acknowledged' },
        } } };
        const normalize = (id: string, raw: unknown) => {
            const message = normalizeRawMessage(id, null, 1, raw);
            if (!message) throw new Error('Invalid admitted tool fixture');
            return message;
        };
        const initialOrigin = { v: 1, serverId: 'home', sessionId: 'parent' };
        reducer(state, [
            normalize('native-call', { ...call, meta: { forkVisualOriginV1: { ...initialOrigin, sourceMessageId: 'native-call', sourceSeq: 1 } } }),
            normalize('native-result', { ...result, meta: { forkVisualOriginV1: { ...initialOrigin, sourceMessageId: 'native-result', sourceSeq: 2 } } }),
        ], null);
        const forkVisualOriginV1 = { v: 1, serverId: 'home', sessionId: 'parent', sourceMessageId: 'call', sourceSeq: 3 };
        const replayedCall = reducer(state, [normalize('import-call', { ...call, meta: { forkVisualOriginV1 } })], null);
        expect(replayedCall.messages).toHaveLength(1);
        expect(replayedCall.messages[0]).toMatchObject({ meta: { forkVisualOriginV1 }, tool: { state: 'completed', result: { stable: 'acknowledged' } } });
        const resultOrigin = { ...forkVisualOriginV1, sourceMessageId: 'result', sourceSeq: 4 };
        const replayedResult = reducer(state, [normalize('import-result', { ...result, meta: { forkVisualOriginV1: resultOrigin } })], null);
        expect(replayedResult.messages).toHaveLength(1);
        expect(replayedResult.messages[0]).toMatchObject({ meta: { forkVisualOriginV1: resultOrigin }, tool: { state: 'completed', result: { stable: 'acknowledged' } } });
    });
});
