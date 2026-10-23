import { describe, expect, it } from 'vitest';

import type { ToolCallMessage } from "./messageTypes.js";
import {
    buildSessionMessageRouteId,
    parseStableSessionMessageRouteId,
    resolveMessageRouteIdForDisplay,
    resolveSessionMessageRouteId,
} from "./messageRouteIds.js";
import { createReducer, reducer } from "../reducer/reducer.js";
import type { NormalizedMessage } from "../raw/index.js";

function makeToolMessage(id: string): ToolCallMessage {
    return {
        kind: 'tool-call',
        id,
        realID: null,
        localId: null,
        createdAt: 1,
        tool: {
            id: 'call_read_1',
            name: 'read',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {},
        },
        children: [],
    };
}

describe('messageRouteIds', () => {
    it('resolves the durable server route emitted for a reduced assistant answer without a dedupe mapping', () => {
        const reducerState = createReducer();
        const answer = {
            id: 'server-answer', localId: null, seq: 5, createdAt: 1,
            role: 'agent', isSidechain: false, content: [{ type: 'text', text: 'Source answer' }],
        } satisfies NormalizedMessage;
        const reduced = reducer(reducerState, [answer]);
        const message = reduced.messages.find(row => row.kind === 'agent-text')!;
        const messagesById = Object.fromEntries(reduced.messages.map(row => [row.id, row]));
        const routeMessageId = resolveMessageRouteIdForDisplay({ message, messagesById, reducerState });
        expect(routeMessageId).toBe('server:server-answer');
        expect(resolveSessionMessageRouteId({ routeMessageId, messagesById, reducerState })).toBe(message.id);
        expect(resolveSessionMessageRouteId({ routeMessageId: 'server:absent', messagesById, reducerState })).toBeNull();
    });
    it('preserves whitespace-distinct opaque local ids in stable routes', () => {
        expect(parseStableSessionMessageRouteId('local: request-1')).toEqual({
            kind: 'local',
            value: ' request-1',
        });
        expect(parseStableSessionMessageRouteId('local:request-1 ')).toEqual({
            kind: 'local',
            value: 'request-1 ',
        });
    });

    it('builds a durable server route for an internal message id when reducer state knows the original id', () => {
        const reducerState = createReducer();
        reducerState.messageIds.set('server-msg-1', 'internal-1');

        const message = makeToolMessage('internal-1');

        const routeId = buildSessionMessageRouteId({
            messageId: message.id,
            messagesById: { [message.id]: message },
            reducerState,
        });

        expect(routeId).toBe('server:server-msg-1');
    });

    it('prefers reducer-backed durable routes over the stale public message id used for display', () => {
        const reducerState = createReducer();
        reducerState.messageIds.set('server-msg-1', 'internal-1');

        const message = makeToolMessage('internal-1');

        const routeId = resolveMessageRouteIdForDisplay({
            message,
            messagesById: { [message.id]: message },
            reducerState,
        });

        expect(routeId).toBe('server:server-msg-1');
    });

    it('falls back to a stable local route when a tool-call has no server id or tool id', () => {
        const message = {
            ...makeToolMessage('internal-1'),
            localId: 'local-msg-1',
            tool: {
                ...makeToolMessage('internal-1').tool,
                id: undefined,
            },
        } satisfies ToolCallMessage;

        const routeId = resolveMessageRouteIdForDisplay({
            message,
            messagesById: { [message.id]: message },
            reducerState: createReducer(),
        });

        expect(routeId).toBe('local:local-msg-1');
    });

    it('resolves a local route back to the current internal message id after reload', () => {
        const reducerState = createReducer();
        reducerState.localIds.set('local-msg-1', 'internal-1');

        const resolved = resolveSessionMessageRouteId({
            routeMessageId: 'local:local-msg-1',
            messagesById: {},
            reducerState,
        });

        expect(resolved).toBe('internal-1');
    });

    it('resolves a stable server route for a persisted tool-call message after reducer hydration', () => {
        const reducerState = createReducer();
        const normalizedToolCall = {
            id: 'server-tool-msg-1',
            localId: null,
            createdAt: 1,
            role: 'agent',
            isSidechain: false,
            content: [
                {
                    type: 'tool-call',
                    id: 'call_read_1',
                    name: 'Read',
                    input: {},
                    description: 'Read file',
                    uuid: 'uuid-call-1',
                    parentUUID: null,
                },
            ],
        } satisfies NormalizedMessage;

        const reduced = reducer(reducerState, [normalizedToolCall]);
        const internalMessageId = reduced.messages[0]?.id ?? null;
        expect(internalMessageId).toBeTruthy();

        const resolved = resolveSessionMessageRouteId({
            routeMessageId: 'server:server-tool-msg-1',
            messagesById: Object.fromEntries(reduced.messages.map((message) => [message.id, message])),
            reducerState,
        });

        expect(resolved).toBe(internalMessageId);
    });
});
