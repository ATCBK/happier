// Load the real Workflow schema owner before the contribution's cyclic SDK graph.
import '@happier-dev/protocol/workflows/workflowV1';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  ExecService,
  PluginProcessResult,
} from '@happier-dev/plugin-sdk/exec';
import type {
  PluginJsonRpcClient,
  PluginProtocolClientHandle,
} from '@happier-dev/plugin-sdk/exec/protocol-clients';

import { createCodexExternalSessionsContribution } from './contribution.js';
import { ExternalSessionCandidateMatchV1Schema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { parseCodexContentSearchProgress } from './transcriptSource.js';

const contentReadClock = vi.hoisted(() => ({ advance: null as (() => void) | null,
  slowOffset: 64 * 1024,
  onRead: null as ((position: number, length: number) => Promise<void>) | null }));
// Native filesystem and clock are the only substituted boundaries.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === 'read') return async (...readArgs: Parameters<typeof target.read>) => {
        const result = await Reflect.apply(target.read, target, readArgs);
        if (typeof readArgs[3] === 'number' && typeof readArgs[2] === 'number') await contentReadClock.onRead?.(readArgs[3], readArgs[2]);
        if (typeof readArgs[3] === 'number' && readArgs[3] >= contentReadClock.slowOffset) contentReadClock.advance?.();
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function processResult(stdout: string): PluginProcessResult {
  return {
    termination: {
      observed: { kind: 'exit', exitCode: 0 },
      requestedBy: { kind: 'none' },
    },
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function createThreadListingExec(
  requests: string[],
  threads: readonly Readonly<{
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    cwd: string;
  }>[] = [{
    id: '33333333-3333-3333-3333-333333333333',
    name: 'Native app-server thread',
    createdAt: 1_768_000_000,
    updatedAt: 1_768_000_100,
    cwd: '/repo/native',
  }],
): ExecService {
  const never = new Promise<PluginProcessResult>(() => undefined);
  const client: PluginJsonRpcClient = {
    async request(method) {
      requests.push(method);
      if (method === 'thread/list') {
        return { data: threads };
      }
      return {};
    },
    async notify() {},
    onNotification: () => ({ dispose: () => undefined }),
    onRequest: () => ({ dispose: () => undefined }),
    dispose: async () => undefined,
  };
  const handle: PluginProtocolClientHandle<'jsonRpc'> = {
    client,
    process: {
      pid: 123,
      write: async () => undefined,
      closeStdin: async () => undefined,
      wait: () => never,
      onOutput: () => ({ dispose: () => undefined }),
      dispose: async () => undefined,
    },
    wait: () => never,
    dispose: async () => undefined,
  };
  return {
    agentCli: { checkReadiness: async () => ({ launchable: [] }) },
    systemTools: {
      resolve: async () => ({
        executable: { kind: 'systemTool', id: 'codex-cli' },
        executablePath: '/fixture/codex',
      }),
    },
    run: vi.fn(async (request: Parameters<ExecService['run']>[0]) => (
      request.args?.[0] === '--version'
        ? processResult('codex-cli 0.145.0\n')
        : processResult('realtime_conversation                under development  false\n')
    )),
    spawn: vi.fn(async () => {
      throw new Error('The native app-server path must use exec.clients.spawn');
    }),
    clients: {
      spawn: async () => handle,
    },
  } as unknown as ExecService;
}

const emptyThreadListingExec = createThreadListingExec([], []);

function invocation(overrides: Readonly<{
  signal?: AbortSignal;
  deadlineAtMs?: number;
  maxSerializedBytes?: number;
  exec?: ExecService;
}> = {}) {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    deadlineAtMs: overrides.deadlineAtMs ?? Date.now() + 30_000,
    maxSerializedBytes: overrides.maxSerializedBytes ?? 64 * 1024,
    exec: overrides.exec ?? emptyThreadListingExec,
    ripgrep: { run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) },
  };
}

describe('Codex public Agent External Sessions contribution', () => {
  it('advances slow native decoding under identical budgets with rollback and semantic ordinals intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-progress-'));
    const clock = Date.now;
    let now = clock();
    try {
      const codexHome = join(root, 'codex-home');
      const day = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(day, { recursive: true });
      const id = '11111111-1111-1111-1111-111111111111';
      const laterId = '22222222-2222-2222-2222-222222222222';
      const path = join(day, `rollout-2026-07-23T08-00-00-${id}.jsonl`);
      const message = (role: string, text: string, minute: number) => jsonl({ type: 'response_item', timestamp: `2026-07-23T08:${String(minute).padStart(2, '0')}:00.000Z`, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
      await writeFile(path, [jsonl({ type: 'session_meta', payload: { id, cwd: '/repo' } }),
        message('user', 'kept prompt', 1), message('assistant', 'kept reply', 2), message('assistant', 'kept reply', 2),
        message('user', 'abandoned prompt', 3), message('assistant', 'body-only phrase abandoned', 4),
        jsonl({ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }),
        message('user', 'replacement prompt', 5),
        ...Array.from({ length: 10_000 }, (_, index) => message('assistant', `dense native reply ${index}`, 5)),
        jsonl({ type: 'response_item', timestamp: '2026-07-23T08:05:10.000Z', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-call', arguments: JSON.stringify({ prompt: 'inspect native correlation', nickname: 'worker', role: 'explorer' }) } }),
        message('assistant', 'interim reply', 5),
        ...Array.from({ length: 4 }, (_, index) => jsonl({ type: 'world_state', payload: { padding: 'x'.repeat(70_000), index } })),
        message('assistant', 'interim reply', 5),
        jsonl({ type: 'response_item', timestamp: '2026-07-23T08:05:20.000Z', payload: { type: 'function_call_output', call_id: 'spawn-call', output: JSON.stringify({ agent_id: 'child-thread' }) } }),
        jsonl({ type: 'event_msg', timestamp: '2026-07-23T08:05:20.000Z', payload: { type: 'collab_agent_spawn_end', new_thread_id: 'child-thread' } }),
        ...Array.from({ length: 4 }, (_, index) => jsonl({ type: 'world_state', payload: { padding: 'x'.repeat(70_000), index } })),
        message('assistant', 'body-only phrase active', 6)].join(''));
      const fixtureBytes = await readFile(path);
      contentReadClock.slowOffset = fixtureBytes.indexOf(Buffer.from('"type":"world_state"')) + 64 * 1024;
      const laterPath = join(day, `rollout-2026-07-23T07-00-00-${laterId}.jsonl`);
      await writeFile(laterPath, jsonl({ type: 'session_meta', payload: { id: laterId, cwd: '/repo' } }) + message('assistant', 'body-only phrase next file', 0));
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome };
      const ripgrep = { run: async () => ({ exitCode: 0, stdout: `${path}\0${laterPath}\0`, stderr: '' }) };
      Date.now = () => now;
      let cursor: string | undefined;
      let firstCursor: string | undefined;
      let semanticCursor: string | undefined;
      let hitCursor: string | undefined;
      const hits: Array<{ remoteSessionId: string; match?: { snippet: string; sourceItemId: string; messageIndex: number } }> = [];
      const seen = new Set<string>();
      for (let page = 0; page < 80; page += 1) {
        contentReadClock.advance = () => { now += 60; };
        const result = await contribution.listCandidates({ ...invocation(), source, maxItems: 1, searchTarget: 'content', searchTerm: 'body-only phrase', scanDeadlineAtMs: now + 100, cursor, ripgrep });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        for (const candidate of result.value.candidates) {
          if (candidate.match) ExternalSessionCandidateMatchV1Schema.parse(candidate.match);
          hits.push(candidate);
        }
        if (!result.value.nextCursor) { cursor = undefined; break; }
        expect(seen.has(result.value.nextCursor)).toBe(false);
        // The native cursor remains inside the real strict result byte budget
        // even with ten thousand projected rows before the slow suffix.
        expect(Buffer.byteLength(result.value.nextCursor)).toBeLessThan(8 * 1024);
        seen.add(result.value.nextCursor);
        firstCursor ??= result.value.nextCursor;
        const envelope = JSON.parse(Buffer.from(result.value.nextCursor, 'base64url').toString()) as Record<string, unknown>;
        const progress = parseCodexContentSearchProgress(envelope.contentProgress);
        if (progress?.phase === 'matching' && progress.streams[0]?.semantic.pending.length) semanticCursor ??= result.value.nextCursor;
        if (progress?.hit) hitCursor ??= result.value.nextCursor;
        cursor = result.value.nextCursor;
      }
      expect(cursor).toBeUndefined();
      expect(hits).toMatchObject([{ remoteSessionId: id, match: { snippet: 'body-only phrase active', messageIndex: 10_005 } }, { remoteSessionId: laterId, match: { snippet: 'body-only phrase next file', messageIndex: 0 } }]);
      expect(firstCursor).toBeDefined();
      if (!firstCursor) throw new Error('Expected native progress');
      contentReadClock.advance = null;
      expect(semanticCursor).toBeDefined();
      expect(hitCursor).toBeDefined();
      if (!semanticCursor || !hitCursor) throw new Error('Expected native semantic and hit continuations');
      const parsed = JSON.parse(Buffer.from(hitCursor, 'base64url').toString()) as Record<string, unknown>;
      const forged = parseCodexContentSearchProgress(parsed.contentProgress);
      if (!forged?.hit) throw new Error('Expected native hit locator');
      // Cursor hit facts cannot authorize a snippet: the actual native row must match.
      const promptOffset = Buffer.byteLength(jsonl({ type: 'session_meta', payload: { id, cwd: '/repo' } }));
      forged.hit.row = { startOffsetBytes: promptOffset, endOffsetBytes: promptOffset + Buffer.byteLength(message('user', 'kept prompt', 1)) };
      forged.hit.id = forged.hit.id.replace(/:\d{12}:\d{3}$/u, `:${String(promptOffset).padStart(12, '0')}:000`);
      parsed.contentProgress = forged;
      await expect(contribution.listCandidates({ ...invocation(), source, maxItems: 1, searchTarget: 'content', searchTerm: 'body-only phrase',
        cursor: Buffer.from(JSON.stringify(parsed)).toString('base64url'), scanDeadlineAtMs: now + 10_000, ripgrep })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });
      const controller = new AbortController();
      const pendingEnvelope = JSON.parse(Buffer.from(semanticCursor, 'base64url').toString()) as Record<string, unknown>;
      const pendingOffset = parseCodexContentSearchProgress(pendingEnvelope.contentProgress)!.streams[0]!.semantic.pending[0]!.row.startOffsetBytes;
      contentReadClock.onRead = async (position) => { if (position === pendingOffset) controller.abort(); };
      await expect(contribution.listCandidates({ ...invocation({ signal: controller.signal }), source, maxItems: 1, searchTarget: 'content', searchTerm: 'body-only phrase',
        cursor: semanticCursor, scanDeadlineAtMs: now + 10_000, ripgrep })).resolves.toMatchObject({ ok: false, code: 'cancelled' });
      let changedAtFinalRow = false;
      contentReadClock.onRead = async (position, length) => {
        if (position > contentReadClock.slowOffset && length < 1024 && !changedAtFinalRow) {
          changedAtFinalRow = true;
          await appendFile(path, jsonl({ type: 'world_state', payload: {} }));
        }
      };
      await expect(contribution.listCandidates({ ...invocation(), source, maxItems: 1, searchTarget: 'content', searchTerm: 'body-only phrase',
        cursor: firstCursor, scanDeadlineAtMs: now + 10_000, ripgrep })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });
      expect(changedAtFinalRow).toBe(true);
      contentReadClock.onRead = null;
      await expect(contribution.listCandidates({ ...invocation(), source, maxItems: 1, searchTarget: 'content', searchTerm: 'body-only phrase',
        cursor: firstCursor, scanDeadlineAtMs: now + 10_000, ripgrep })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });
    } finally { contentReadClock.advance = null; contentReadClock.onRead = null; contentReadClock.slowOffset = 64 * 1024; Date.now = clock; await rm(root, { recursive: true, force: true }); }
  });
  it('yields content work at its cooperative scan deadline while retaining hard invocation enforcement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-content-deadline-'));
    const clock = Date.now;
    let now = clock();
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      const rolloutPath = join(sessionsDir, `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`);
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({ type: 'session_meta', timestamp: '2026-07-23T08:00:00.000Z', payload: { id: remoteSessionId, cwd: '/repo' } }),
        jsonl({ type: 'response_item', timestamp: '2026-07-23T08:01:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'body-only phrase' }] } }),
      ].join(''));
      const contribution = createCodexExternalSessionsContribution({ env: { CODEX_HOME: codexHome } });
      const request = {
        ...invocation(), source: { kind: 'codexHome', home: 'user', homePath: codexHome }, maxItems: 10,
        searchTarget: 'content' as const, searchTerm: 'body-only phrase', scanDeadlineAtMs: now + 100,
        // Only the host subprocess/clock boundaries are substituted; native scanning and decoding remain real.
        ripgrep: { run: async () => { now += 100; return { exitCode: 0, stdout: `${rolloutPath}\0`, stderr: '' }; } },
      };
      Date.now = () => now;
      const first = await contribution.listCandidates(request);
      expect(first).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial', nextCursor: expect.any(String) } });
      if (!first.ok || !first.value.nextCursor) throw new Error('Expected content continuation');
      await expect(contribution.listCandidates({ ...request, deadlineAtMs: now, scanDeadlineAtMs: now + 100 })).resolves.toMatchObject({ ok: false, code: 'timeout' });
      const hardDeadlineAtMs = now + 30_000;
      await expect(contribution.listCandidates({ ...request, deadlineAtMs: hardDeadlineAtMs, scanDeadlineAtMs: now + 100,
        ripgrep: { run: async () => { now = hardDeadlineAtMs; return { exitCode: 0, stdout: `${rolloutPath}\0`, stderr: '' }; } } })).resolves.toMatchObject({ ok: false, code: 'timeout' });
      const resumed = await contribution.listCandidates({ ...request, scanDeadlineAtMs: now + 1000, cursor: first.value.nextCursor,
        deadlineAtMs: now + 30_000,
        ripgrep: { run: async () => ({ exitCode: 0, stdout: `${rolloutPath}\0`, stderr: '' }) } });
      expect(resumed).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId, match: { snippet: expect.stringContaining('body-only phrase') } }], contentCoverage: 'complete' } });
    } finally { Date.now = clock; await rm(root, { recursive: true, force: true }); }
  });

  it('uses the invocation ExecService to list native app-server threads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-native-threads-'));
    try {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      const requests: string[] = [];
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.listCandidates({
        source: { kind: 'codexHome', home: 'user' },
        maxItems: 10,
        // Native app-server listing is part of the searched browse; an
        // unsearched browse selects the bounded rollout chunk/preparation mode.
        searchTerm: '33333333',
        searchMode: 'full',
        ...invocation({ exec: createThreadListingExec(requests) }),
      })).resolves.toMatchObject({
        ok: true,
        value: {
          candidates: [{
            remoteSessionId: '33333333-3333-3333-3333-333333333333',
            title: 'Native app-server thread',
          }],
        },
      });

      expect(requests.filter((method) => method === 'thread/list')).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['tail', 'a missing source'],
    [
      'eyJ2IjoyLCJraW5kIjoiY29kZXhGb3J3YXJkQXBwU2VydmVyIiwidXBkYXRlZEF0TXMiOjE3MzYwMDAxMDAwMDAsInByZXZpZXdUZXh0IjoiUmVsZWFzZWQgcHJldmlldyJ9',
      'a disappeared released app-server source',
    ],
  ])('forwards source_unavailable for %s (%s)', async (cursor) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-unavailable-'));
    try {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.readAfterTranscript({
        source: { kind: 'codexHome', home: 'user' },
        remoteSessionId: '11111111-1111-1111-1111-111111111111',
        cursor,
        maxItems: 20,
        ...invocation(),
      })).resolves.toEqual({
        ok: true,
        value: { outcome: 'source_unavailable' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a typed failure instead of a cursor when a current rollout record is unsupported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-unsupported-record-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      const rolloutPath = join(
        sessionsDir,
        `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`,
      );
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({ type: 'unsupported_record', payload: { ignored: true } }),
      ].join(''), 'utf8');
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;

      await expect(contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 20,
        ...invocation(),
      })).resolves.toMatchObject({
        ok: false,
        code: 'agent_error',
        retryable: false,
      });

      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'initial item' }],
          },
        }),
      ].join(''), 'utf8');
      const initial = await contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 20,
        ...invocation(),
      });
      if (!initial.ok || !initial.value.tailCursor) {
        throw new Error('Expected a valid Codex transcript cursor');
      }

      await appendFile(rolloutPath, jsonl({
        type: 'response_item',
        payload: { type: 'unrecognized_current_shape' },
      }));
      await expect(contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: initial.value.tailCursor,
        maxItems: 20,
        ...invocation(),
      })).resolves.toMatchObject({
        ok: false,
        code: 'agent_error',
        retryable: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports an unreadable rollout as an Agent fault rather than an unavailable Agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-unreadable-rollout-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '11111111-1111-1111-1111-111111111111';
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`), Buffer.concat([
        Buffer.from(jsonl({ type: 'session_meta', payload: { id: remoteSessionId, cwd: '/repo' } })),
        Buffer.from('{"type":"response_item","payload":{"type":"message","role":"user","content":"'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"}}\n'),
      ]));
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.pageTranscript({
        source: { kind: 'codexHome', home: 'user', homePath: codexHome },
        remoteSessionId,
        direction: 'older',
        maxItems: 20,
        ...invocation(),
      })).resolves.toMatchObject({ ok: false, code: 'agent_error' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns typed unsupported rather than an authoritative empty page for newer paging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-newer-unsupported-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '44444444-4444-4444-4444-444444444444';
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T09-00-00-${remoteSessionId}.jsonl`),
        [
          jsonl({
            type: 'session_meta',
            payload: { id: remoteSessionId, cwd: '/repo' },
          }),
          jsonl({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'older-only history' }],
            },
          }),
        ].join(''),
        'utf8',
      );
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });

      await expect(contribution.pageTranscript({
        source: { kind: 'codexHome', home: 'user', homePath: codexHome },
        remoteSessionId,
        direction: 'newer',
        maxItems: 10,
        ...invocation(),
      })).resolves.toEqual({
        ok: false,
        code: 'unsupported',
        message: 'Codex external-session newer paging is not supported.',
        retryable: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the rollout owners candidate, link identity, transcript, and cursor semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-external-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });
      const firstSessionId = '11111111-1111-1111-1111-111111111111';
      const secondSessionId = '22222222-2222-2222-2222-222222222222';
      const firstFile = join(sessionsDir, `rollout-2026-07-23T08-00-00-${firstSessionId}.jsonl`);
      await writeFile(firstFile, [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T08:00:00.000Z',
          payload: { id: firstSessionId, timestamp: '2026-07-23T08:00:00.000Z', cwd: '/repo/first' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:01:00.000Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'first public message' }],
          },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:02:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'first public response' }],
          },
        }),
      ].join(''), 'utf8');
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T09-00-00-${secondSessionId}.jsonl`),
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T09:00:00.000Z',
          payload: { id: secondSessionId, timestamp: '2026-07-23T09:00:00.000Z', cwd: '/repo/second' },
        }),
        'utf8',
      );

      const env = { CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
      const activeServerDir = join(root, 'active-server');
      const contribution = createCodexExternalSessionsContribution({ env });
      const source = { kind: 'codexHome', home: 'user' } as const;
      const resolvedSource = await contribution.resolveSource({ source, ...invocation() });
      expect(resolvedSource).toEqual({
        ok: true,
        value: {
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
          transcriptMediaReadRoots: [codexHome],
          accountingSource: {
            rootPath: codexHome,
            rootField: 'homePath',
            resourceKey: expect.stringMatching(/^codex:accounting:[A-Za-z0-9_-]{43}$/u),
            changeObservation: 'watch_file_changes',
            watchFileChanges: {
              files: [firstFile, join(sessionsDir, `rollout-2026-07-23T09-00-00-${secondSessionId}.jsonl`)],
              topologyDirectories: [
                join(codexHome, 'archived_sessions'),
                join(codexHome, 'sessions'),
                join(codexHome, 'sessions', '2026'),
                join(codexHome, 'sessions', '2026', '07'),
                sessionsDir,
              ],
            },
          },
        },
      });
      if (!resolvedSource.ok) throw new Error('Expected resolved Codex source');

      const listed = await contribution.listCandidates({
        source: resolvedSource.value.source,
        maxItems: 1,
        searchMode: 'fast',
        ...invocation(),
      });
      expect(listed).toMatchObject({
        ok: true,
        value: {
          candidates: [{ remoteSessionId: secondSessionId }],
          nextCursor: expect.any(String),
        },
      });
      if (!listed.ok) throw new Error('Expected Codex candidates');
      expect(listed.value.candidates).toHaveLength(1);
      expect(listed.value.candidates[0]?.linkData).toMatchObject({
        source: { kind: 'codexHome', home: 'user', homePath: codexHome },
      });

      const firstCandidate = await contribution.listCandidates({
        source: resolvedSource.value.source,
        maxItems: 10,
        searchTerm: firstSessionId,
        searchMode: 'fast',
        ...invocation(),
      });
      if (!firstCandidate.ok) throw new Error('Expected first Codex candidate');

      const fullSearch = await contribution.listCandidates({
        source: resolvedSource.value.source,
        maxItems: 10,
        searchTerm: 'first public message',
        searchMode: 'full',
        ...invocation(),
      });
      expect(fullSearch).toMatchObject({
        ok: true,
        value: {
          candidates: [{ remoteSessionId: firstSessionId }],
          nextCursor: null,
        },
      });
      if (!fullSearch.ok) throw new Error('Expected complete Codex rollout search');
      expect(fullSearch.value.searchIncomplete).toBeUndefined();

      const identity = await contribution.resolveLinkIdentity({
        source: resolvedSource.value.source,
        remoteSessionId: firstSessionId,
        linkData: firstCandidate.value.candidates[0]?.linkData,
        ...invocation(),
      });
      expect(identity).toMatchObject({
        ok: true,
        value: {
          source: { kind: 'codexHome', home: 'user', homePath: codexHome },
          remoteSessionId: firstSessionId,
          transcriptMediaReadRoots: [codexHome],
          linkData: {
            source: { kind: 'codexHome', home: 'user', homePath: codexHome },
          },
        },
      });
      if (!identity.ok) throw new Error('Expected Codex identity');

      const page = await contribution.pageTranscript({
        source: identity.value.source,
        remoteSessionId: identity.value.remoteSessionId,
        direction: 'older',
        maxItems: 10,
        ...invocation(),
      });
      expect(page).toMatchObject({
        ok: true,
        value: {
          items: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
          tailCursor: expect.any(String),
        },
      });
      if (!page.ok) throw new Error('Expected Codex transcript');
      expect(page.value.items.some((item) => item.messageRole === 'user')).toBe(true);
      expect(page.value.items.some((item) => item.messageRole === 'agent')).toBe(true);

      await appendFile(firstFile, jsonl({
        type: 'response_item',
        timestamp: '2026-07-23T08:02:00.000Z',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'follow-up public message' }],
        },
      }), 'utf8');
      const after = await contribution.readAfterTranscript({
        source: identity.value.source,
        remoteSessionId: firstSessionId,
        cursor: page.value.tailCursor!,
        maxItems: 10,
        ...invocation(),
      });
      expect(after).toMatchObject({
        ok: true,
        value: {
          items: [expect.objectContaining({ id: expect.any(String) })],
        },
      });
      if (!after.ok) throw new Error('Expected Codex transcript continuation');
      expect(after.value.items[0]).toMatchObject({
        id: expect.any(String),
        messageRole: 'agent',
        raw: {
          role: 'agent',
          content: {
            type: 'codex',
            data: {
              type: 'message',
              message: 'follow-up public message',
            },
          },
        },
      });
      expect(after.value.items[0]?.id).not.toBe(page.value.items[0]?.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('advances a bounded nonempty appended suffix with a continuation cursor instead of reporting a gap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-read-after-bound-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '44444444-4444-4444-4444-444444444444';
      const rolloutPath = join(
        sessionsDir,
        `rollout-2026-07-23T08-00-00-${remoteSessionId}.jsonl`,
      );
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T08:00:00.000Z',
          payload: { id: remoteSessionId, cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:01:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'initial' }],
          },
        }),
      ].join(''), 'utf8');
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;
      const initial = await contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 10,
        ...invocation(),
      });
      if (!initial.ok || !initial.value.tailCursor) {
        throw new Error('Expected a Codex tail cursor');
      }

      await appendFile(rolloutPath, [
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:02:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'first appended item' }],
          },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T08:03:00.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'second appended item' }],
          },
        }),
      ].join(''), 'utf8');

      const firstBounded = await contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: initial.value.tailCursor,
        maxItems: 1,
        ...invocation(),
      });
      if (!firstBounded.ok || firstBounded.value.outcome !== 'advanced') {
        throw new Error('Expected a bounded appended suffix to advance');
      }
      expect(firstBounded.value.items).toHaveLength(1);
      expect(JSON.stringify(firstBounded.value.items[0])).toContain('first appended item');
      expect(firstBounded.value.hasMore).toBe(true);
      expect(firstBounded.value.nextCursor).toEqual(expect.any(String));

      // The bounded page's continuation cursor must make progress without
      // repeating or dropping the appended suffix.
      const secondBounded = await contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: firstBounded.value.nextCursor,
        maxItems: 1,
        ...invocation(),
      });
      if (!secondBounded.ok || secondBounded.value.outcome !== 'advanced') {
        throw new Error('Expected the bounded continuation to advance');
      }
      expect(secondBounded.value.items).toHaveLength(1);
      expect(JSON.stringify(secondBounded.value.items[0])).toContain('second appended item');
      expect(secondBounded.value.hasMore).toBe(false);
      expect(secondBounded.value.nextCursor).toEqual(expect.any(String));

      await expect(contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: secondBounded.value.nextCursor,
        maxItems: 1,
        ...invocation(),
      })).resolves.toEqual({
        ok: true,
        value: { outcome: 'already_current' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('advances malformed UTF-8 diagnostics through the public read-after result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-malformed-'));
    try {
      const codexHome = join(root, 'codex-home');
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      const remoteSessionId = '33333333-3333-3333-3333-333333333333';
      const rolloutPath = join(
        sessionsDir,
        `rollout-2026-07-23T10-00-00-${remoteSessionId}.jsonl`,
      );
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(rolloutPath, [
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T10:00:00.000Z',
          payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
        }),
        jsonl({
          type: 'response_item',
          timestamp: '2026-07-23T10:00:01.000Z',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'initial' }],
          },
        }),
      ].join(''), 'utf8');
      const contribution = createCodexExternalSessionsContribution({
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      });
      const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;
      const page = await contribution.pageTranscript({
        source,
        remoteSessionId,
        direction: 'older',
        maxItems: 10,
        ...invocation(),
      });
      if (!page.ok || !page.value.tailCursor) throw new Error('Expected Codex tail cursor');

      const before = (await readFile(rolloutPath)).byteLength;
      const prefix = Buffer.from(
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"',
        'utf8',
      );
      await appendFile(
        rolloutPath,
        Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from('"}]}}\n', 'utf8')]),
      );

      await expect(contribution.readAfterTranscript({
        source,
        remoteSessionId,
        cursor: page.value.tailCursor,
        maxItems: 10,
        ...invocation(),
      })).resolves.toMatchObject({
        ok: true,
        value: {
          outcome: 'advanced',
          items: [],
          nextCursor: expect.any(String),
          boundary: expect.any(String),
          diagnostics: [{
            code: 'malformed_source_utf8',
            severity: 'required',
            count: 1,
            positions: [before + prefix.byteLength],
          }],
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed for cancellation, deadlines, invalid item limits, and unfit byte bounds', async () => {
    const controller = new AbortController();
    controller.abort();
    const contribution = createCodexExternalSessionsContribution({
      env: { CODEX_HOME: '/tmp/codex-public-bounds' } as NodeJS.ProcessEnv,
    });
    const source = { kind: 'codexHome', home: 'user' } as const;

    expect(await contribution.resolveSource({
      source,
      ...invocation({ signal: controller.signal }),
    })).toMatchObject({ ok: false, code: 'cancelled' });
    expect(await contribution.resolveSource({
      source,
      ...invocation({ deadlineAtMs: Date.now() - 1 }),
    })).toMatchObject({ ok: false, code: 'timeout' });
    await expect(contribution.listCandidates({
      source,
      maxItems: 0,
      searchMode: 'fast',
      ...invocation(),
    })).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    // A byte bound that is not a positive size is a MALFORMED inbound request.
    expect(await contribution.resolveSource({
      source,
      ...invocation({ maxSerializedBytes: 0 }),
    })).toMatchObject({ ok: false, code: 'invalid_request' });
    // A well-formed bound the Agent's own OUTPUT cannot fit is not a caller
    // mistake to correct: it is a nonretryable Agent-side failure, and it is the
    // same classification the host's bounded-invocation owner already applies
    // when a leaf overruns the identical budget.
    expect(await contribution.resolveSource({
      source,
      ...invocation({ maxSerializedBytes: 1 }),
    })).toMatchObject({ ok: false, code: 'agent_error', retryable: false });
  });

  it('keeps connected-service home identity qualified through candidates and persisted links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-public-connected-home-'));
    try {
      const activeServerDir = join(root, 'active-server');
      const codexHome = join(
        activeServerDir,
        'daemon',
        'connected-services',
        'homes',
        'openai-codex',
        'profile-1',
        'codex',
        'codex-home',
      );
      const sessionsDir = join(codexHome, 'sessions', '2026', '07', '23');
      await mkdir(sessionsDir, { recursive: true });
      const remoteSessionId = '33333333-3333-3333-3333-333333333333';
      await writeFile(
        join(sessionsDir, `rollout-2026-07-23T10-00-00-${remoteSessionId}.jsonl`),
        jsonl({
          type: 'session_meta',
          timestamp: '2026-07-23T10:00:00.000Z',
          payload: { id: remoteSessionId, timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo/connected' },
        }),
        'utf8',
      );
      const contribution = createCodexExternalSessionsContribution({
        env: {} as NodeJS.ProcessEnv,
      });
      const source = {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
        homePath: codexHome,
      } as const;
      const admittedSource = source;

      const listed = await contribution.listCandidates({
        source,
        maxItems: 10,
        searchMode: 'fast',
        ...invocation(),
      });
      expect(listed).toMatchObject({
        ok: true,
        value: {
          candidates: [{
            remoteSessionId,
            linkData: { source: admittedSource },
          }],
        },
      });
      if (!listed.ok) throw new Error('Expected connected-service Codex candidate');

      const linked = await contribution.resolveLinkedIdentity({
        source,
        remoteSessionId,
        linkData: listed.value.candidates[0]?.linkData ?? {},
        ...invocation(),
      });
      expect(linked).toMatchObject({
        ok: true,
        value: {
          source: admittedSource,
          remoteSessionId,
          linkData: { source: admittedSource },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('requires the host-admitted connected-service home before granting media read roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-media-read-roots-'));
    try {
      const activeServerDir = join(root, 'active-server');
      const verifiedHome = join(
        activeServerDir,
        'daemon',
        'connected-services',
        'homes',
        'openai-codex',
        'profile-1',
        'codex',
        'codex-home',
      );
      await mkdir(join(verifiedHome, 'sessions'), { recursive: true });
      const contribution = createCodexExternalSessionsContribution({
        env: {} as NodeJS.ProcessEnv,
      });
      const unstampedSource = {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'profile-1',
      } as const;

      await expect(contribution.resolveSource({
        source: unstampedSource,
        ...invocation(),
      })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });

      const resolvedVerified = await contribution.resolveSource({
        source: { ...unstampedSource, homePath: verifiedHome },
        ...invocation(),
      });
      if (!resolvedVerified.ok) throw new Error('Expected a resolved Codex source');
      expect(resolvedVerified.value.transcriptMediaReadRoots).toEqual([await realpath(verifiedHome)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves link identity with the provider session id byte-exact and rejects blank', async () => {
    // Codex mints this id; the resolved link identity and the descriptor it
    // writes must address the same provider session the caller named.
    const exactRemoteSessionId = '  provider\nses/AB+cd==  ';
    const codexHome = '/tmp/codex-public-link-identity-exact';
    const contribution = createCodexExternalSessionsContribution({
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });
    const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;

    expect(await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: exactRemoteSessionId,
      linkData: {
        codexBackendMode: 'appServer',
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          agent: {
            backendMode: 'appServer',
            providerSessionId: exactRemoteSessionId,
            appServerTransport: 'daemonProxy',
          },
        },
      },
      ...invocation(),
    })).toMatchObject({
      ok: true,
      value: {
        remoteSessionId: exactRemoteSessionId,
        linkData: {
          runtimeDescriptorV1: {
            agent: {
              providerSessionId: exactRemoteSessionId,
              appServerTransport: 'daemonProxy',
            },
          },
        },
      },
    });

    expect(await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: ' \n\t ',
      linkData: { codexBackendMode: 'appServer' },
      ...invocation(),
    })).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('canonicalizes supported backend-mode aliases and rejects unsupported link identity modes', async () => {
    const codexHome = '/tmp/codex-public-link-identity';
    const contribution = createCodexExternalSessionsContribution({
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });
    const source = { kind: 'codexHome', home: 'user', homePath: codexHome } as const;

    expect(await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: 'thread-alias',
      linkData: { codexBackendMode: 'mcp_resume' },
      ...invocation(),
    })).toMatchObject({
      ok: true,
      value: {
        remoteSessionId: 'thread-alias',
        linkData: {
          codexBackendMode: 'acp',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            agent: {
              backendMode: 'acp',
              providerSessionId: 'thread-alias',
            },
          },
        },
      },
    });

    expect(await contribution.resolveLinkIdentity({
      source,
      remoteSessionId: 'thread-invalid',
      linkData: { codexBackendMode: 'unsupported-mode' },
      ...invocation(),
    })).toMatchObject({
      ok: false,
      code: 'source_invalid',
      message: 'codex_backend_mode_unsupported',
    });
    expect(await contribution.resolveLinkedIdentity({
      source,
      remoteSessionId: 'thread-invalid',
      linkData: { codexBackendMode: 'unsupported-mode' },
      ...invocation(),
    })).toMatchObject({
      ok: false,
      code: 'source_invalid',
      message: 'codex_backend_mode_unsupported',
    });
  });
});
