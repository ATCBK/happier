import { expect, it } from 'vitest';
import { SessionMessageReplyOperationV1Schema, SessionMessageReplyOutcomeV1Schema, SessionMessageReplyResolvedOutcomeV1Schema } from './sessionMessageReplyV1.js';

it('admits a closed native committed-result binding on the existing fulfillment operation', () => {
  const operation = { kind: 'fulfill', turnId: 'turn', outcome: { kind: 'cancelled', result: { sessionId: 'session', messageId: 'committed' } },
    nativeResult: { runId: 'run', sidechainId: 'sidechain', localId: 'native-row' } };
  expect(SessionMessageReplyOperationV1Schema.parse(operation)).toEqual(operation);
  expect(SessionMessageReplyOperationV1Schema.safeParse({ ...operation,
    nativeResult: { ...operation.nativeResult, partialText: 'private' } }).success).toBe(false);
  expect(SessionMessageReplyOperationV1Schema.safeParse({ ...operation, outcome: { kind: 'cancelled' } }).success).toBe(false);
});

it('keeps stopped partial content out of custody and exposes it only in a resolved result', () => {
  const result = { sessionId: 'participant', messageId: 'partial-row' };
  expect(SessionMessageReplyOutcomeV1Schema.parse({ kind: 'cancelled', result })).toEqual({ kind: 'cancelled', result });
  expect(SessionMessageReplyOutcomeV1Schema.safeParse({ kind: 'cancelled', partialText: 'private' }).success).toBe(false);
  const resolved = { kind: 'cancelled', partialText: 'partial'.repeat(20_000),
    messageRef: { kind: 'session', session: { serverId: 'home', sessionId: 'participant' }, messageId: 'partial-row' } };
  expect(SessionMessageReplyResolvedOutcomeV1Schema.parse(resolved)).toEqual(resolved);
  expect(SessionMessageReplyResolvedOutcomeV1Schema.safeParse({ ...resolved, arbitrary: true }).success).toBe(false);
  expect(SessionMessageReplyOutcomeV1Schema.parse({ kind: 'cancelled' })).toEqual({ kind: 'cancelled' });
});
