import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Initialize the canonical Workflow graph before the SDK's broad author exports.
import '@happier-dev/protocol/workflows/workflowV1';
import { createOhMyPiExternalSessionsContribution } from './contribution.js';

// Slow real native reads are an OS boundary; codecs and search remain real.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir) };
});

const roots: string[] = [];

type NativeFixtureRecord = {
  type: string;
  id?: string;
  message?: { role: string; content: { type: string; text?: string }[] };
};

// Sanitized emitted native rows, retaining envelopes, ids and parent ancestry:
// can1357/oh-my-pi@9124912bbc928b1d60abe66485ba2b04a0f18f04,
// packages/coding-agent/test/fixtures/large-session.jsonl, first 120 rows.
async function nativeFixture() {
  const body = await readFile(new URL('./__fixtures__/native-session-prefix.jsonl', import.meta.url), 'utf8');
  // The tracked external fixture is admitted by the real native codec below.
  return body.trim().split('\n').map((line) => JSON.parse(line) as NativeFixtureRecord);
}
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fileSystem.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fileSystem.opendir).mockReset().mockImplementation(actual.opendir);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const agentDir = await mkdtemp(join(tmpdir(), 'happier-ohmypi-content-'));
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
  const contribution = createOhMyPiExternalSessionsContribution({ env: {} });
  const request = {
    signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000,
    maxSerializedBytes: 1024 * 1024, maxItems: 10,
    source: { kind: 'ohMyPiAgentDir', agentDir }, searchTarget: 'content' as const,
    // Host subprocess boundary only; actual transcript decoding/matching stays real.
    ripgrep: { run: vi.fn(async ({ paths }: { paths: readonly string[] }) => ({ exitCode: 0,
      stdout: paths.join('\0') + '\0', stderr: '', stdoutTruncated: false })) },
  };
  return { contribution, request, body };
}

describe('ohmypi direct conversation content search', () => {
  it('advances equally budgeted native pages, preserving active-branch ordinals and reaching the next file', async () => {
    const { contribution, request } = await fixture();
    const { ExternalSessionsCandidatesListResponseSchema } = await import('@happier-dev/protocol/sessions/external/daemonRpcV1');
    const directory = join(request.source.agentDir, 'sessions', '-repo');
    const path = join(directory, '2026-07-23T10-00-00-000Z_session.jsonl');
    const rows = await nativeFixture();
    const sessionId = rows.find((row) => row.type === 'session')?.id;
    if (!sessionId) throw new Error('Native fixture must have its session header');
    const textRows = rows.filter((row) => row.message?.role === 'assistant'
      && row.message.content.some((block) => block.type === 'text'));
    textRows[0]!.message!.content.find((block) => block.type === 'text')!.text = 'slow native needle earliest';
    textRows.at(-1)!.message!.content.find((block) => block.type === 'text')!.text = 'slow native needle latest';
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const nextRows = structuredClone(rows.slice(0, 3));
    nextRows.find((row) => row.type === 'session')!.id = 'next-native-session';
    nextRows.find((row) => row.message?.role === 'user')!.message!.content[0]!.text = 'slow native needle next';
    await writeFile(join(directory, 'next.jsonl'), nextRows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const nativePage = await contribution.pageTranscript({ ...request, maxItems: 1000,
      source: { ...request.source, sessionFilePath: path }, remoteSessionId: sessionId, direction: 'older' });
    if (!nativePage.ok) throw new Error(`${nativePage.code}: ${nativePage.message}`);
    const expectedIndex = nativePage.value.items.findIndex((item) => JSON.stringify(item.raw).includes('slow native needle earliest'));
    expect(expectedIndex).toBeGreaterThanOrEqual(0);
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fileSystem.opendir).mockImplementation(async (...args) => {
      const directory = await actual.opendir(...args);
      clock += 15_000;
      return directory;
    });
    vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      // Native candidate inspection consumes this page's cooperative deadline.
      clock += 15_000;
      return handle;
    });
    const hits = [];
    let cursor: string | null = null;
    let partialPages = 0;
    for (let page = 0; page < 40; page += 1) {
      const result = await contribution.listCandidates({ ...request, maxItems: 10, searchTerm: 'slow native needle',
        deadlineAtMs: clock + 1_000_000, scanDeadlineAtMs: clock + 15_000, ...(cursor ? { cursor } : {}) });
      if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      expect(ExternalSessionsCandidatesListResponseSchema.safeParse({ ok: true, ...result.value }).success).toBe(true);
      hits.push(...result.value.candidates);
      if (!result.value.nextCursor) {
        expect(result.value.contentCoverage).toBe('complete');
        cursor = null;
        break;
      }
      partialPages += 1;
      expect(result.value.contentCoverage).toBe('partial');
      if (cursor) expect(result.value.nextCursor).not.toBe(cursor);
      cursor = result.value.nextCursor;
    }
    expect(partialPages).toBeGreaterThan(1);
    expect(cursor).toBeNull();
    expect(hits.map(hit => hit.remoteSessionId).sort()).toEqual([sessionId, 'next-native-session'].sort());
    expect(hits.find(hit => hit.remoteSessionId === sessionId)?.match).toEqual({ snippet: 'slow native needle earliest', messageIndex: expectedIndex,
      sourceItemId: nativePage.value.items[expectedIndex]!.id });
  });
  it.each(['body-only phrase', 'body-only phrase with "quotes"\n東京', '東京 café'])('finds decoded active-branch body %s with its transcript locator', async (query) => {
    const { contribution, request, body } = await fixture();
    const result = await contribution.listCandidates({ ...request, searchTerm: query });
    expect(result).toMatchObject({ ok: true, value: {
      candidates: [{ remoteSessionId: 'session', match: { snippet: expect.stringContaining(query), sourceItemId: expect.any(String), messageIndex: 1 } }],
      contentCoverage: 'complete', nextCursor: null,
    } });
    if (!result.ok) return;
    const page = await contribution.pageTranscript({ ...request, source: { ...request.source, sessionFilePath: join(request.source.agentDir, 'sessions', '-repo', '2026-07-23T10-00-00-000Z_session.jsonl') }, remoteSessionId: 'session', direction: 'older' });
    expect(page.ok && page.value.items[1]?.id).toBe(result.value.candidates[0]?.match?.sourceItemId);
    if (!page.ok) throw new Error('Expected the native transcript used by search');
    expect(result.value.candidates[0]).toMatchObject({ cwd: '/repo', messageCount: page.value.items.length });
    expect(body).toContain(query);
  });

  it('refuses cancellation and changed native bytes while a transcript continuation is pending', async () => {
    const { contribution, request } = await fixture();
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      clock += 3000;
      return handle;
    });
    const first = await contribution.listCandidates({ ...request, maxItems: 1, searchTerm: 'body-only',
      deadlineAtMs: clock + 1_000_000, scanDeadlineAtMs: clock + 15_000 });
    expect(first).toMatchObject({ ok: true, value: { contentCoverage: 'partial', nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) throw new Error('Expected pending native progress');
    const continuation = { ...request, maxItems: 1, searchTerm: 'body-only', cursor: first.value.nextCursor,
      deadlineAtMs: clock + 1_000_000, scanDeadlineAtMs: clock + 15_000 };
    const cancelled = new AbortController();
    vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      cancelled.abort();
      return handle;
    });
    await expect(contribution.listCandidates({ ...continuation, signal: cancelled.signal })).resolves.toMatchObject({ ok: false, code: 'cancelled' });
    vi.mocked(fileSystem.open).mockImplementation(actual.open);
    const path = join(request.source.agentDir, 'sessions', '-repo', '2026-07-23T10-00-00-000Z_session.jsonl');
    await writeFile(path, (await actual.readFile(path, 'utf8')).replace('body-only', 'different'));
    await expect(contribution.listCandidates(continuation)).resolves.toMatchObject({ ok: false, code: 'source_invalid' });
  });

  it.each(['abandoned-only phrase', 'metadata-only phrase'])('excludes %s from content matches', async (searchTerm) => {
    const { contribution, request } = await fixture();
    await expect(contribution.listCandidates({ ...request, searchTerm })).resolves.toMatchObject({
      ok: true, value: { candidates: [], contentCoverage: 'complete' },
    });
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
