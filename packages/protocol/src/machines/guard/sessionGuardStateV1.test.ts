import { describe, expect, it } from 'vitest';
import { TranscriptRawAgentEventV1Schema } from '../../sessions/messages/transcriptRawRecordV1.js';
import { SessionGuardNoticeRequestV1Schema, buildSessionStopTranscriptEventV1,
  readSessionStopTranscriptRecordV1, readSessionMemoryCeilingOverride,
  applySessionMemoryCeilingOverrideToMetadata } from './sessionGuardStateV1.js';

describe('Session guard notice contract', () => {
  it('reads the retained override without treating unknown stored fields as authority or invalid bytes as absence', () => {
    expect(readSessionMemoryCeilingOverride({})).toBeUndefined();
    expect(readSessionMemoryCeilingOverride({ sessionGuardStateV1: {
      v: 1, kind: 'configured', ceilingBytes: null, futurePresentation: true } })).toBeNull();
    expect(readSessionMemoryCeilingOverride({ sessionGuardStateV1: {
      v: 1, kind: 'stopping', stopAt: 300_000, rule: 'idle_sessions', ceilingBytes: 4096 } })).toBe(4096);
    expect(() => readSessionMemoryCeilingOverride({ sessionGuardStateV1: { v: 1, kind: 'configured', ceilingBytes: 0 } })).toThrow();
    const metadata = { privateOtherField: 'retained', sessionGuardStateV1: {
      v: 1, kind: 'stopping', stopAt: 300_000, rule: 'idle_sessions', futurePresentation: true } };
    expect(applySessionMemoryCeilingOverrideToMetadata(metadata, null)).toEqual({
      ...metadata, sessionGuardStateV1: { ...metadata.sessionGuardStateV1, ceilingBytes: null } });
    expect(applySessionMemoryCeilingOverrideToMetadata({}, 4096).sessionGuardStateV1)
      .toEqual({ v: 1, kind: 'configured', ceilingBytes: 4096 });
  });
  it('preserves a typed stop marker in the existing informational transcript event', () => {
    const record = { v: 1, at: 1000, rule: 'memory_guard', freedBytes: 4096, status: 'requested' } as const;
    const event = TranscriptRawAgentEventV1Schema.parse(buildSessionStopTranscriptEventV1(record));
    expect(event.type).toBe('message');
    expect(readSessionStopTranscriptRecordV1(event)).toEqual(record);
    expect(readSessionStopTranscriptRecordV1({ ...event, sessionStopV1: { ...record, privateDetail: 'unsafe' } })).toEqual(record);
    expect(readSessionStopTranscriptRecordV1({ ...event, sessionStopV1: { ...record, at: -1, privateDetail: 'unsafe' } })).toBeNull();
    expect(() => buildSessionStopTranscriptEventV1({ ...record, privateDetail: 'unsafe' })).toThrow();
    expect(readSessionStopTranscriptRecordV1({ type: 'message', message: 'ordinary' })).toBeNull();
  });

  it('never commits a settlement snapshot as the immutable pre-stop transcript event', () => {
    const record = { v: 1, at: 1000, rule: 'memory_guard', status: 'stopped' } as const;
    expect(() => buildSessionStopTranscriptEventV1(record)).toThrow();
    expect(readSessionStopTranscriptRecordV1({ type: 'message', sessionStopV1: record })).toBeNull();
  });

  it('rejects a notice carrying content or ambiguous state while accepting cancellation', () => {
    expect(SessionGuardNoticeRequestV1Schema.safeParse({ sessionId: 'session', state: { kind: 'clear' } }).success).toBe(true);
    expect(SessionGuardNoticeRequestV1Schema.safeParse({ sessionId: 'session', state: {
      kind: 'stopping', stopAt: 1000, rule: 'memory_guard', prompt: 'private',
    } }).success).toBe(false);
    expect(SessionGuardNoticeRequestV1Schema.safeParse({ sessionId: 'session', state: {
      kind: 'stopping', stopAt: 1000, rule: 'ceiling',
    } }).success).toBe(false);
  });
});
