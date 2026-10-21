import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createDaemonControlApp } from './controlServer';
import { createDaemonAdmissionDrain } from './lifecycle/admissionDrain';
import { SessionActivityChangedResponseSchema } from './sessions/sessionActivityChangedContract';
import { reloadConfiguration } from '@/configuration';
import { logger } from '@/ui/logger';
import axios from 'axios';
import { createSessionFollowOccurrenceDispatcher } from '@/agent/runtime/session/follow/sessionFollowOccurrenceDispatcher';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

describe('private Session activity invalidation', () => {
  it('correlates a source occurrence before waiting for dispatch without logging its authored local id or evidence', async () => {
    const log = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
      if (path === '/v2/account/session-follow-preferences') return { status: 200,
        data: { assigned: false, direct: false, team: false, group: false } };
      if (path === '/v2/account/session-follow-rules') { entered = true; await gate; return { status: 503, data: {} }; }
      throw new Error(`Unexpected GET ${path}`);
    });
    const dispatcher = createSessionFollowOccurrenceDispatcher({ accountId: 'account-1', credentials: {
      token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature', encryption: null,
    }, serverId: 'home', serverHttpBaseUrl: 'http://follow-ingress.test', machineId: 'machine', installationId: 'installation',
      signal: new AbortController().signal, isCurrent: async () => true, subscribeInvalidation: () => () => {},
      resolveSourceKeyContext: async () => null, isPersonalCurrent: () => false, dispatchPersonal: async () => {} });
    const app = createDaemonControlApp({
      getChildren: () => [{ pid: 1, startedBy: 'daemon', happySessionId: 'source' }], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'source' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'token',
      onSessionActivityChanged: async (_sessionId, occurrence) => {
        if (occurrence && !('original' in occurrence)) return await dispatcher.dispatch(occurrence);
      },
    });
    const occurrence = { sourceSessionId: 'source', sourcePublisher: {
      machineId: 'machine', committedFenceMs: 1, publisherGeneration: '1',
    }, sourceMessage: { localId: 'private-authored-original', seq: 7 }, evidence: {
      v: 1, ownerAccountId: 'account-1', event: { kind: 'update_posted' }, facts: { serverId: 'private-home', kind: 'session' },
    } };
    try {
      const pending = app.inject({ method: 'POST', url: '/session-activity-changed',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: 'source', followOccurrence: occurrence } }).then(result => result);
      await vi.waitFor(() => expect(entered).toBe(true));
      const checkpoints = () => log.mock.calls.filter(([message]) => message === '[Session Follow] Occurrence ingress')
        .map(([, fields]) => fields);
      expect(checkpoints()).toEqual([expect.objectContaining({ requestId: expect.any(String), sourceSessionId: 'source',
        sourceMessageSeq: 7, status: 'started' })]);
      release();
      expect((await pending).statusCode).toBe(200);
      expect(checkpoints().at(-1)).toMatchObject({ sourceSessionId: 'source', sourceMessageSeq: 7, status: 'completed' });
      const ignored = await app.inject({ method: 'POST', url: '/session-activity-changed',
        headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId: 'source',
          followOccurrence: { ...occurrence, sourceSessionId: 'private-mismatched-source' } } });
      expect(ignored.statusCode).toBe(200);
      expect(checkpoints().at(-1)).toEqual({ requestId: expect.any(String), status: 'ignored' });
      expect(JSON.stringify(checkpoints())).not.toContain('private-');
    } finally { release(); await app.close(); dispatcher.dispose(); http.mockRestore(); log.mockRestore(); }
  });

  it('forwards canonical Run hints after the parent retires and rejects a mismatched source Session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'happier-run-follow-hint-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
    const received: unknown[] = [];
    try {
      const app = createDaemonControlApp({
        getChildren: () => [], machineId: 'machine', stopSession: async () => ({ status: 'not_found' }),
        spawnSession: async () => ({ type: 'success', sessionId: 'parent' }), requestShutdown: () => {},
        onHappySessionWebhook: () => {}, controlToken: 'token',
        onSessionActivityChanged: (_sessionId, occurrence) => { received.push(occurrence); },
      });
      try {
        const notify = (sessionId: string, terminalEventId: string, sourceSessionId = sessionId) => app.inject({ method: 'POST', url: '/session-activity-changed',
          headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId,
            followOccurrence: { original: { source: { kind: 'execution_run', sessionId: sourceSessionId, runId: 'run-1' }, terminalEventId },
              event: { kind: 'failed_or_stopped' } } },
        });
        expect((await notify('parent', 'terminal-1')).statusCode).toBe(200);
        expect(received).toEqual([{ original: { source: { kind: 'execution_run', sessionId: 'parent', runId: 'run-1' }, terminalEventId: 'terminal-1' },
          event: { kind: 'failed_or_stopped' } }]);
        expect((await notify('parent', 'old-terminal')).statusCode).toBe(200);
        expect(received).toEqual(['terminal-1', 'old-terminal'].map(terminalEventId => ({
          original: { source: { kind: 'execution_run', sessionId: 'parent', runId: 'run-1' }, terminalEventId },
          event: { kind: 'failed_or_stopped' },
        })));
        expect((await notify('other', 'terminal-1', 'parent')).statusCode).toBe(200);
        expect(received).toHaveLength(2);
      } finally { await app.close(); }
    } finally {
      vi.unstubAllEnvs();
      reloadConfiguration();
      rmSync(directory, { recursive: true, force: true });
    }
  });
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
      expect(SessionActivityChangedResponseSchema.safeParse({ ...SessionActivityChangedResponseSchema.parse(response.json()), privateRuleId: 'not-transportable' }).success).toBe(false);
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
      onSessionActivityChanged: sessionId => { if (sessionId) changed.push(sessionId); },
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
