import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { createDaemonControlApp } from './controlServer';
import { createDaemonAdmissionDrain } from './lifecycle/admissionDrain';
import { SessionActivityChangedResponseSchema } from './sessions/sessionActivityChangedContract';
import { reloadConfiguration } from '@/configuration';
import { retainExecutionRunState } from './executionRunRegistry';
import type { ExecutionRunState } from '@/agent/runtime/bridges/executionRun/executionRunTypes';

describe('private Session activity invalidation', () => {
  it('re-reads an exact retained terminal Run before dispatch even after its parent runner retires', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'happier-run-follow-hint-'));
    vi.stubEnv('HAPPIER_HOME_DIR', directory);
    reloadConfiguration();
    const run = { runId: 'run-1', callId: 'call', sidechainId: 'side', sessionId: 'parent', depth: 0,
      intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex', instructions: '',
      permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
      status: 'failed', startedAtMs: 1, finishedAtMs: 2, terminalOccurrenceId: 'terminal-1',
    } satisfies ExecutionRunState;
    const received: unknown[] = [];
    try {
      await retainExecutionRunState(run);
      const app = createDaemonControlApp({
        getChildren: () => [], machineId: 'machine', stopSession: async () => ({ status: 'not_found' }),
        spawnSession: async () => ({ type: 'success', sessionId: 'parent' }), requestShutdown: () => {},
        onHappySessionWebhook: () => {}, controlToken: 'token',
        onSessionActivityChanged: (_sessionId, occurrence) => { received.push(occurrence); },
      });
      try {
        const notify = (sessionId: string, terminalEventId: string) => app.inject({ method: 'POST', url: '/session-activity-changed',
          headers: { 'x-happier-daemon-token': 'token' }, payload: { sessionId,
            runFollowOccurrence: { source: { kind: 'execution_run', sessionId, runId: 'run-1' }, terminalEventId } },
        });
        expect((await notify('parent', 'terminal-1')).statusCode).toBe(200);
        expect(received).toEqual([{ source: { kind: 'execution_run', sessionId: 'parent', runId: 'run-1' }, terminalEventId: 'terminal-1' }]);
        expect((await notify('parent', 'old-terminal')).statusCode).toBe(200);
        expect((await notify('other', 'terminal-1')).statusCode).toBe(200);
        expect(received).toHaveLength(1);
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
