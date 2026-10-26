import { describe, expect, it } from 'vitest';
import { SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';

import { groupFollowNoticesBySource } from './followNoticeGroups';

const finished = (sourceSessionId: string, turnId: string) => SessionFollowInputV1Schema.parse({
    v: 1, delivery: 'next_turn',
    original: { sourceSessionId, sourceTurn: { id: turnId, status: 'completed' } },
    event: { kind: 'finished' },
});
const needsYou = (sourceSessionId: string, requestId: string) => SessionFollowInputV1Schema.parse({
    v: 1, delivery: 'next_turn',
    original: { sourceSessionId, sourceRequests: { agentStateVersion: 1, requests: [{ requestId, createdAt: 1 }] } },
    requestEvents: [{ requestId, event: { kind: 'needs_you', type: 'approval' } }],
});
const row = (id: string, followInput: ReturnType<typeof finished> | null, foldable = true) => ({ id, followInput, foldable });

describe('groupFollowNoticesBySource', () => {
    it('keeps equal run ids in distinct Session and Machine scopes separate', () => {
        const run = (scope: { sessionId: string } | { machineId: string }, terminalEventId: string) => SessionFollowInputV1Schema.parse({
            v: 1, delivery: 'next_turn', original: { source: { kind: 'execution_run', runId: 'same-run', ...scope }, terminalEventId },
            event: { kind: 'finished' },
        });
        const groups = groupFollowNoticesBySource([
            row('a1', run({ sessionId: 'session-a' }, 't1')),
            row('b1', run({ sessionId: 'session-b' }, 't1')),
            row('m1', run({ machineId: 'session-a' }, 't1')),
            row('a2', run({ sessionId: 'session-a' }, 't2')),
        ]);
        expect(groups.get('a1')).toEqual({ kind: 'lead', count: 2, followInput: run({ sessionId: 'session-a' }, 't2') });
        expect(groups.get('a2')).toEqual({ kind: 'folded' });
        expect(groups.has('b1')).toBe(false);
        expect(groups.has('m1')).toBe(false);
    });
    it('shows several queued updates from one source as one notice at the first arrival, counted', () => {
        const groups = groupFollowNoticesBySource([
            row('a1', finished('worker-a', 't1')), row('a2', finished('worker-a', 't2')), row('a3', finished('worker-a', 't3')),
        ]);
        expect(groups.get('a1')).toEqual({ kind: 'lead', count: 3, followInput: finished('worker-a', 't3') });
        expect(groups.get('a2')).toEqual({ kind: 'folded' });
        expect(groups.get('a3')).toEqual({ kind: 'folded' });
    });

    it('lets a needs-you update win over later quiet ones, and the latest needs-you over an earlier one', () => {
        const groups = groupFollowNoticesBySource([
            row('a1', finished('worker-a', 't1')), row('a2', needsYou('worker-a', 'r1')),
            row('a3', needsYou('worker-a', 'r2')), row('a4', finished('worker-a', 't4')),
        ]);
        expect(groups.get('a1')).toEqual({ kind: 'lead', count: 4, followInput: needsYou('worker-a', 'r2') });
    });

    it('keeps different sources, lone updates and rows that are not plainly queued as they are', () => {
        const groups = groupFollowNoticesBySource([
            row('a1', finished('worker-a', 't1')), row('b1', finished('worker-b', 't1')),
            row('a2', finished('worker-a', 't2')), row('a3', finished('worker-a', 't3'), false),
            row('m1', null), row('m2', null),
        ]);
        expect(groups.get('a1')).toEqual({ kind: 'lead', count: 2, followInput: finished('worker-a', 't2') });
        expect(groups.get('a2')).toEqual({ kind: 'folded' });
        for (const id of ['b1', 'a3', 'm1', 'm2']) expect(groups.has(id)).toBe(false);
    });
});
