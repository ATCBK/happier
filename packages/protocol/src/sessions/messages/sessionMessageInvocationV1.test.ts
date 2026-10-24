import { describe, expect, it } from 'vitest';
import { projectSessionMessageInvocationV1, readSessionMessageInvocationV1, SessionMessageInvocationV1Schema } from './sessionMessageInvocationV1.js';

describe('source Session message invocation', () => {
  it('retains frozen mixed admission and inline result references without copying private result/error text', () => {
    const row = projectSessionMessageInvocationV1({ serverId: 'home', localId: 'attempt', requestLocalId: 'attempt',
      target: { selector: 'workers' }, reply: 'wait', result: { ok: true, result: { kind: 'fanout', results: [
        { target: { serverId: 'home', sessionId: 'a' }, result: { ok: true, result: { status: 'accepted', localId: 'input-a' } } },
        { target: { serverId: 'home', sessionId: 'b' }, result: { ok: false, errorCode: 'permission_denied', error: 'PRIVATE ERROR' } },
        { target: { serverId: 'home', sessionId: 'c' }, result: { ok: true, result: { status: 'replied', localId: 'input-c',
          outcome: { kind: 'answer', text: 'PRIVATE ANSWER', messageRef: { kind: 'session', session: { serverId: 'home', sessionId: 'c' }, messageId: 'answer-c' } } } } },
      ] } } });
    expect(row.targets.map(target => [target.target.sessionId, target.localId, target.immediate.status]))
      .toEqual([['a', 'input-a', 'accepted'], ['b', 'attempt', 'rejected'], ['c', 'input-c', 'replied']]);
    expect(row.targets[2]?.immediate).toMatchObject({ outcome: 'answer', resultRef: { messageId: 'answer-c' } });
    expect(JSON.stringify(row)).not.toContain('PRIVATE');
    expect(readSessionMessageInvocationV1({ type: 'message', message: 'Question', sessionMessageInvocationV1: row })).toEqual(row);
    expect(SessionMessageInvocationV1Schema.safeParse({ ...row, authority: 'present_user' }).success).toBe(false);
    expect(readSessionMessageInvocationV1({ type: 'message', message: 'Legacy message' })).toBeNull();
  });
});
