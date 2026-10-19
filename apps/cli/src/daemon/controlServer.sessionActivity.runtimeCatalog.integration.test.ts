import { describe, expect, it } from 'vitest';
import { createDaemonControlApp } from './controlServer';
import { createDaemonAdmissionDrain } from './lifecycle/admissionDrain';
import { SessionActivityChangedResponseSchema } from './sessions/sessionActivityChangedContract';

describe('private Session activity invalidation', () => {
  it('returns only the captured source contribution through the authenticated closed response', async () => {
    const app = createDaemonControlApp({
      getChildren: () => [{ pid: 1, startedBy: 'daemon', happySessionId: 'session' }], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'session' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      onSessionActivityChanged: async () => ({ personalFollow: { sourceSessionId: 'session',
        requests: [{ requestId: 'question', policies: [{ preset: 'important' as const }] }] } }),
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/session-activity-changed',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: 'session' } });
      expect(response.statusCode).toBe(200);
      expect(SessionActivityChangedResponseSchema.parse(response.json())).toEqual({ ok: true, personalFollow: {
        sourceSessionId: 'session', requests: [{ requestId: 'question', policies: [{ preset: 'important' }] }],
      } });
      expect(SessionActivityChangedResponseSchema.safeParse({ ...response.json(), privateRuleId: 'not-transportable' }).success).toBe(false);
    } finally { await app.close(); }
  });
  it('accepts only authenticated content-free current Session edges and preserves publication during temporary drain', async () => {
    const changed: string[] = [];
    const drain = createDaemonAdmissionDrain();
    const app = createDaemonControlApp({
      getChildren: () => [{ pid: 1, startedBy: 'daemon', happySessionId: 'session' }], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'session' }), requestShutdown: () => {},
      onHappySessionWebhook: () => {}, controlToken: 'token', admissionDrain: drain,
      onSessionActivityChanged: sessionId => { changed.push(sessionId); },
    });
    try {
      await app.ready();
      const notify = (payload: Record<string, unknown>, token = 'token') => app.inject({ method: 'POST', url: '/session-activity-changed',
        headers: { 'x-happier-daemon-token': token }, payload,
      });
      expect((await notify({ sessionId: 'session' }, 'wrong')).statusCode).toBe(401);
      expect((await notify({ sessionId: 'session', idle: true })).statusCode).toBe(400);
      expect((await notify({ sessionId: 'retired' })).statusCode).toBe(200);
      expect(changed).toEqual([]);
      drain.beginTemporaryDrain();
      expect((await notify({ sessionId: 'session' })).statusCode).toBe(200);
      expect(changed).toEqual(['session']);
      drain.beginShutdown();
      expect((await notify({ sessionId: 'session' })).statusCode).toBe(503);
    } finally { await app.close(); }
  });
});
