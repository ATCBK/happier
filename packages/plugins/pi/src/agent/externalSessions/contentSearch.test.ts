import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
// Initialize the real Workflow schema before SDK imports while its Mini migration
// has an order-dependent cycle; no domain logic is mocked.
import '@happier-dev/protocol/workflows/workflowV1';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fileSystem from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { SessionManager } from 'pi-coding-agent-0821';
import type { AssistantMessage } from 'pi-ai-0821';
import { createPiExternalSessionsContribution } from './contribution.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir), stat: vi.fn(actual.stat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fileSystem.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fileSystem.opendir).mockReset().mockImplementation(actual.opendir);
  vi.mocked(fileSystem.stat).mockReset().mockImplementation(actual.stat);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const agentDir = await mkdtemp(join(tmpdir(), 'happier-pi-content-'));
  roots.push(agentDir);
  const directory = join(agentDir, 'sessions', '-repo');
  await mkdir(directory, { recursive: true });
  const path = join(directory, '2026-07-23T10-00-00-000Z_session.jsonl');
  const record = (id: string, parentId: string | null, message: unknown) =>
    ({ type: 'message', id, parentId, timestamp: '2026-07-23T10:00:00.000Z', message });
  const body = 'body-only phrase with "quotes"\n東京 café';
  const records = [
    { type: 'session', version: 3, id: 'session', timestamp: '2026-07-23T10:00:00.000Z', cwd: '/repo' },
    record('user', null, { role: 'user', content: 'ordinary title' }),
    record('abandoned', 'user', { role: 'assistant', content: [{ type: 'text', text: 'abandoned-only phrase' }] }),
    record('active', 'user', { role: 'assistant', content: [{ type: 'text', text: body }] }),
    record('tools', 'active', { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'bash', arguments: { command: 'metadata-only phrase' } }] }),
  ];
  await writeFile(path, records.map((record) => JSON.stringify(record).replaceAll('東京', '\\u6771\\u4eac')).join('\n') + '\n');
  const contribution = createPiExternalSessionsContribution({ env: {} });
  const request = {
    signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000,
    maxSerializedBytes: 1024 * 1024, maxItems: 10,
    source: { kind: 'piAgentDir', agentDir }, searchTarget: 'content' as const,
    // Host subprocess boundary only; actual transcript decoding/matching stays real.
    ripgrep: { run: vi.fn(async () => ({ exitCode: 0, stdout: path + '\0', stderr: '', stdoutTruncated: false })) },
  };
  return { contribution, request, body };
}

describe('pi direct conversation content search', () => {
  it('closes directory resources for abandoned, superseded and cancelled pages', async () => {
    const { contribution, request } = await fixture();
    await writeFile(join(request.source.agentDir, 'sessions', '-repo', 'second.jsonl'), [
      { type: 'session', version: 3, id: 'second', timestamp: '2026-07-24T10:00:00.000Z', cwd: '/repo' },
      { type: 'message', id: 'user', parentId: null, timestamp: '2026-07-24T10:00:00.000Z',
        message: { role: 'user', content: 'ordinary second title' } },
    ].map(line => JSON.stringify(line)).join('\n') + '\n');
    const opened: Dir[] = [];
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fileSystem.opendir).mockImplementation(async (...args) => {
      const directory = await actual.opendir(...args);
      opened.push(directory);
      return directory;
    });
    for (let index = 0; index < 18; index += 1) {
      const controller = new AbortController();
      const page = await contribution.listCandidates({ ...request, signal: controller.signal,
        maxItems: 1, searchTarget: 'metadata', searchTerm: index % 2 ? 'ordinary' : '' });
      expect(page).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
      // Settled host invocations abort their private signal; abandonment and
      // query replacement never call back into the plugin with a scan lifetime.
      controller.abort();
      for (const directory of opened.splice(0)) {
        await expect(directory.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
      }
    }
    const controller = new AbortController();
    const check = controller.signal.throwIfAborted.bind(controller.signal);
    let checks = 0;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (++checks === 2) controller.abort();
      check();
    });
    await expect(contribution.listCandidates({ ...request, signal: controller.signal,
      maxItems: 1, searchTerm: 'ordinary' })).resolves.toMatchObject({ ok: false, code: 'cancelled' });
    expect(opened.length).toBeGreaterThan(0);
    for (const directory of opened) {
      await expect(directory.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
    }
  });

  it('advances native branch pages across identical slow budgets and continues beyond the file', async () => {
    const { ExternalSessionCandidateV1Schema, ExternalSessionCandidateMatchV1Schema, ExternalSessionsCandidatesListResponseSchema } = await import('@happier-dev/protocol/sessions/external/daemonRpcV1');
    const agentDir = await mkdtemp(join(tmpdir(), 'happier-pi-progress-'));
    roots.push(agentDir);
    await mkdir(join(agentDir, 'sessions', '-empty'), { recursive: true });
    await mkdir(join(agentDir, 'sessions', '-irrelevant'), { recursive: true });
    await writeFile(join(agentDir, 'sessions', '-irrelevant', 'notes.txt'), 'not a native transcript');
    const directory = join(agentDir, 'sessions', '-repo');
    await mkdir(directory, { recursive: true });
    const assistant = (text: string): AssistantMessage => ({
      role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions',
      provider: 'openai', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    // Native Pi 0.82.1 writes the session tree, including its abandoned branch.
    const native = SessionManager.create('/repo', directory);
    const root = native.appendMessage({ role: 'user', content: 'ordinary title', timestamp: Date.now() });
    native.appendMessage(assistant('native progress needle abandoned café'));
    native.branch(root);
    const hitId = native.appendMessage(assistant('native progress needle earliest café'));
    for (let index = 0; index < 30; index += 1) {
      native.appendMessage({ role: 'user', content: index === 29 ? 'native progress needle latest café' : 'ordinary '.repeat(20), timestamp: Date.now() });
    }
    const later = SessionManager.create('/repo', directory);
    later.appendMessage({ role: 'user', content: 'later title', timestamp: Date.now() });
    later.appendMessage(assistant('native progress needle next file café'));
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fileSystem.stat).mockImplementation(async (...args) => {
      const metadata = await actual.stat(...args);
      clock += 15_000;
      return metadata;
    });
    vi.mocked(fileSystem.opendir).mockImplementation(async (...args) => {
      const directory = await actual.opendir(...args);
      clock += 15_000;
      return directory;
    });
    vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      // Native candidate header/tail preparation alone exceeds the scan budget.
      clock += 6000;
      return handle;
    });
    let contribution = createPiExternalSessionsContribution({ env: {} });
    // The subprocess spends an entire scan budget; repeating this optimization
    // on continuation would prevent even a committed native page from advancing.
    const ripgrep = { run: async () => {
      clock += 15_000;
      return { exitCode: 0, stdout: native.getSessionFile() + '\0', stderr: '' };
    } };
    const request = () => ({
      source: { kind: 'piAgentDir', agentDir }, signal: new AbortController().signal,
      deadlineAtMs: clock + 1_000_000, scanDeadlineAtMs: clock + 15_000,
      maxItems: 2, maxSerializedBytes: 4096, searchTarget: 'content' as const, searchTerm: 'native progress needle', ripgrep,
    });
    const hits = [];
    let cursor: string | null = null;
    let partialPages = 0;
    for (let page = 0; page < 50; page += 1) {
      const result = await contribution.listCandidates({
        ...request(),
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      ExternalSessionsCandidatesListResponseSchema.parse({ ok: true, ...result.value });
      for (const candidate of result.value.candidates) {
        expect(ExternalSessionCandidateMatchV1Schema.safeParse(candidate.match).success).toBe(true);
        hits.push(ExternalSessionCandidateV1Schema.parse(candidate));
      }
      const previousCursor = cursor;
      cursor = result.value.nextCursor;
      // A settled page must leave no plugin-held scan state. Native branch
      // progress belongs to the cursor even after activation is replaced.
      contribution = createPiExternalSessionsContribution({ env: {} });
      if (!cursor) {
        expect(result.value.contentCoverage).toBe('complete');
        break;
      }
      partialPages += 1;
      expect(result.value.contentCoverage).toBe('partial');
      if (previousCursor) expect(cursor, JSON.stringify({ page,
        previous: JSON.parse(Buffer.from(previousCursor, 'base64url').toString('utf8')),
        current: JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
      })).not.toBe(previousCursor);
    }
    expect(partialPages).toBeGreaterThan(1);
    expect(cursor).toBeNull();
    expect(hits.map((candidate) => candidate.remoteSessionId).sort()).toEqual([native.getSessionId(), later.getSessionId()].sort());
    expect(hits.find((candidate) => candidate.remoteSessionId === native.getSessionId())?.match).toMatchObject({ snippet: 'native progress needle earliest café',
      sourceItemId: `pi:${native.getSessionId()}:${hitId}:text:0`, messageIndex: 1 });
    const startPartialScan = async () => {
      cursor = null;
      for (let page = 0; page < 3; page += 1) {
        const result = await contribution.listCandidates({ ...request(), ...(cursor ? { cursor } : {}) });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        cursor = result.value.nextCursor;
        expect(cursor).not.toBeNull();
      }
      return cursor!;
    };
    const cancelledCursor = await startPartialScan();
    const cancelled = new AbortController();
    let boundedReads = 0;
    vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      clock += 1000;
      if (args[0] === native.getSessionFile()) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
          // Bridge the OS read overloads transparently; all bytes remain native.
          const result = await Reflect.apply(read, handle, readArgs) as Awaited<ReturnType<typeof handle.read>>;
          if (Buffer.isBuffer(readArgs[0]) && readArgs[0].length <= 4096) {
            boundedReads += 1;
            // The small header read precedes the resumed native scanner read.
            if (boundedReads === 2) cancelled.abort();
          }
          return result;
        });
      }
      return handle;
    });
    await expect(contribution.listCandidates({ ...request(), cursor: cancelledCursor, signal: cancelled.signal }))
      .resolves.toMatchObject({ ok: false, code: 'cancelled' });
    expect(boundedReads).toBe(2);
    await expect(contribution.listCandidates({ ...request(), cursor: cancelledCursor }))
      .resolves.toMatchObject({ ok: true });
    vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      clock += 1000;
      return handle;
    });
    const changedCursor = await startPartialScan();
    // A native append changes this source, even though the directory inventory
    // is unchanged. An already selected branch cannot remain authoritative.
    native.appendMessage({ role: 'user', content: 'new native branch tail', timestamp: Date.now() });
    await expect(contribution.listCandidates({ ...request(), cursor: changedCursor }))
      .resolves.toMatchObject({ ok: false, code: 'source_invalid' });
    await expect(contribution.listCandidates({ ...request(), deadlineAtMs: clock + 1500,
      ripgrep: { run: async () => ({ exitCode: 0, stdout: native.getSessionFile() + '\0', stderr: '' }) } }))
      .resolves.toMatchObject({ ok: false, code: 'timeout' });
  });

  it.each(['body-only phrase', 'body-only phrase with "quotes"\n東京', '東京 café'])('finds decoded active-branch body %s with its transcript locator', async (query) => {
    const { contribution, request, body } = await fixture();
    const result = await contribution.listCandidates({ ...request, searchTerm: query });
    expect(result).toMatchObject({ ok: true, value: {
      candidates: [{ remoteSessionId: 'session', match: { snippet: expect.stringContaining(query), sourceItemId: expect.any(String), messageIndex: 1 } }],
      contentCoverage: 'complete', nextCursor: null,
    } });
    if (!result.ok) return;
    const page = await contribution.pageTranscript({ ...request, source: { ...request.source, sessionFile: join(request.source.agentDir, 'sessions', '-repo', '2026-07-23T10-00-00-000Z_session.jsonl') }, remoteSessionId: 'session', direction: 'older' });
    expect(page.ok && page.value.items[1]?.id).toBe(result.value.candidates[0]?.match?.sourceItemId);
    if (!page.ok) throw new Error('Expected the native transcript used by search');
    expect(result.value.candidates[0]).toMatchObject({ cwd: '/repo', messageCount: page.value.items.length });
    expect(body).toContain(query);
  });

  it.each(['abandoned-only phrase', 'metadata-only phrase'])('excludes %s from content matches', async (searchTerm) => {
    const { contribution, request } = await fixture();
    await expect(contribution.listCandidates({ ...request, searchTerm })).resolves.toMatchObject({
      ok: true, value: { candidates: [], contentCoverage: 'complete' },
    });
  });

  it('keeps a native interrupted-write tail partial instead of claiming a complete conversation search', async () => {
    const { contribution, request } = await fixture();
    await appendFile(join(request.source.agentDir, 'sessions', '-repo', '2026-07-23T10-00-00-000Z_session.jsonl'), '{"type":"message"');
    await expect(contribution.listCandidates({ ...request, searchTerm: '東京 café' }))
      .resolves.toMatchObject({ ok: true, value: { contentCoverage: 'partial' } });
  });

  it('keeps the full projected message ordinal when native transcript pages are small', async () => {
    const { contribution, request } = await fixture();
    await expect(contribution.listCandidates({ ...request, maxItems: 1, searchTerm: 'body-only phrase' })).resolves.toMatchObject({
      ok: true, value: { candidates: [{ match: { messageIndex: 1 } }], contentCoverage: 'complete' },
    });
  });

  it('preserves literal query whitespace instead of broadening a content search', async () => {
    const { contribution, request } = await fixture();
    await expect(contribution.listCandidates({ ...request, searchTerm: ' body-only phrase' })).resolves.toMatchObject({
      ok: true, value: { candidates: [], contentCoverage: 'complete' },
    });
  });

  it('yields at the cooperative scan deadline while the hard invocation remains valid and binds continuation to query and target', async () => {
    const { contribution, request } = await fixture();
    const now = Date.now();
    let clock = now;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const scanDeadlineAtMs = now + 1000;
    request.ripgrep.run.mockImplementation(async () => {
      clock = scanDeadlineAtMs;
      return { exitCode: 0, stdout: 'hit\0', stderr: '', stdoutTruncated: false };
    });
    const first = await contribution.listCandidates({ ...request, maxItems: 1, scanDeadlineAtMs, searchTerm: 'body-only' });
    expect(first).toMatchObject({ ok: true, value: { contentCoverage: 'partial', searchIncomplete: true, nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) return;
    await expect(contribution.listCandidates({ ...request, deadlineAtMs: clock, scanDeadlineAtMs: clock + 1000, searchTerm: 'body-only' })).resolves.toMatchObject({ ok: false, code: 'timeout' });
    clock = now;
    await expect(contribution.listCandidates({ ...request, deadlineAtMs: scanDeadlineAtMs, scanDeadlineAtMs, searchTerm: 'body-only' })).resolves.toMatchObject({ ok: false, code: 'timeout' });
    clock = now;
    const nextRequest = { ...request, ripgrep: { run: vi.fn(async () => ({ exitCode: 0, stdout: 'hit\0', stderr: '', stdoutTruncated: false })) }, cursor: first.value.nextCursor };
    await expect(contribution.listCandidates({ ...nextRequest, searchTerm: 'different' })).resolves.toMatchObject({ ok: false });
    await expect(contribution.listCandidates({ ...nextRequest, searchTarget: 'metadata', searchTerm: 'body-only' })).resolves.toMatchObject({ ok: false });
    await expect(contribution.listCandidates({ ...nextRequest, searchTerm: 'body-only' })).resolves.toMatchObject({ ok: true, value: { candidates: [{ match: { messageIndex: 1 } }], contentCoverage: 'complete' } });
  });
});
