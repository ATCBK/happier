import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import * as nativeFileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@happier-dev/protocol/workflows/workflowV1';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { AgentExternalSessionTranscriptRawRecordSchema, type AgentExternalSessionsContribution } from '@happier-dev/plugin-sdk/sessions/external';
import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';

// Permission failures are a genuine OS boundary. Native parsing, source
// admission and transcript continuation remain real beneath it.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const roots: string[] = [];
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(nativeFileSystem.realpath).mockReset().mockImplementation(actual.realpath);
  await Promise.all(disposals.splice(0).map(dispose => dispose()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'happier-droid-reader-'));
  roots.push(home);
  const factoryDir = join(home, '.factory');
  const directory = join(factoryDir, 'sessions', '-workspace');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'session-fixture.jsonl');
  const body = await readFile(new URL('./__fixtures__/droid-0.170.0-transcript-v2.jsonl', import.meta.url), 'utf8');
  await writeFile(path, body);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  disposals.push(async () => { await activation.dispose(); vi.unstubAllEnvs(); });
  const contribution = activation.registration('agents', 'droid')?.externalSessions;
  expect(contribution, 'Droid must bind its native external-session reader').toBeDefined();
  if (!contribution) throw new Error('Droid reader is missing');
  const request = { source: { kind: 'droidFactoryDir', factoryDir }, signal: new AbortController().signal,
    maxItems: 50, maxSerializedBytes: 1024 * 1024,
    ripgrep: { run: async () => ({ exitCode: 0, stdout: path + '\0', stderr: '' }) } };
  return { contribution: contribution as AgentExternalSessionsContribution, request, home, factoryDir, path, body };
}
const message = (id: string, parentId: string, text: string) => ({ type: 'message', id, parentId,
  timestamp: '2026-07-13T20:20:10.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
describe('Droid public native-session reader', () => {
  it('normalizes filesystem activity into transport-safe integral milliseconds', async () => {
    const { contribution, request, path } = await fixture();
    await utimes(path, 1_800_000_000.123456, 1_800_000_000.123456);
    const result = await contribution.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'pong' });
    if (!result.ok) throw new Error(result.code);
    expect(result.value.candidates).toHaveLength(1);
    expect(Number.isSafeInteger(result.value.candidates[0]!.updatedAtMs)).toBe(true);
    const { ExternalSessionsCandidatesListResponseSchema } = await import('@happier-dev/protocol/sessions/external/daemonRpcV1');
    expect(ExternalSessionsCandidatesListResponseSchema.safeParse({ ok: true, ...result.value }).success).toBe(true);
  });
  it('uses the active native parent chain and excludes hidden context, reasoning, abandoned branches and tool metadata', async () => {
    const { contribution, request } = await fixture();
    const result = await contribution.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'pong' });
    expect(result).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: 'session-fixture',
      match: { snippet: expect.stringContaining('pong'), messageIndex: 1 } }], contentCoverage: 'partial' } });
    for (const searchTerm of ['abandoned answer', 'hidden system context', 'hidden reasoning', 'hidden document', 'Read']) {
      const negative = await contribution.listCandidates({ ...request, searchTarget: 'content', searchTerm });
      expect(negative).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    }
  });
  it('preserves escaped non-ASCII and long bodies, source locators, paging and append/read-after while detecting a branch rewind', async () => {
    const { contribution, request, path, body } = await fixture();
    const text = 'x'.repeat(270_000) + ' body-only "quoted"\n東京 café';
    await appendFile(path, JSON.stringify(message('long-answer', 'assistant-active', text)).replaceAll('東京', '\\u6771\\u4eac') + '\n');
    const found = await contribution.listCandidates({ ...request, searchTarget: 'content', searchTerm: '東京 café' });
    expect(found).toMatchObject({ ok: true, value: { candidates: [{ match: { snippet: expect.stringContaining('東京 café') } }] } });
    const linked = await contribution.resolveLinkIdentity({ ...request, remoteSessionId: 'session-fixture' });
    if (!linked.ok) throw new Error(linked.code);
    const page = await contribution.pageTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', direction: 'older' });
    if (!page.ok) throw new Error(page.code);
    expect(page.value.items).toHaveLength(4);
    for (const item of page.value.items) expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
    expect(JSON.stringify(page.value.items.at(-1)?.raw)).toContain('東京 café');
    expect(found.ok && found.value.candidates[0]?.match?.sourceItemId).toBe(page.value.items.at(-1)?.id);
    const cursor = page.value.tailCursor;
    if (!cursor) throw new Error('Expected append cursor');
    await appendFile(path, JSON.stringify(message('append', 'long-answer', 'appended answer')) + '\n');
    expect(await contribution.readAfterTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', cursor })).toMatchObject({ ok: true, value: { outcome: 'advanced', items: [{ raw: { role: 'agent' } }] } });
    await appendFile(path, JSON.stringify(message('branch', 'user-active', 'branched answer')) + '\n');
    expect(await contribution.readAfterTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', cursor }))
      .toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
    await writeFile(path, body + JSON.stringify(message('rewind', 'user-active', 'replacement answer')) + '\n');
    expect(await contribution.readAfterTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', cursor })).toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
    const partialPage = await contribution.pageTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', direction: 'older', maxItems: 1 });
    expect(partialPage).toMatchObject({ ok: true, value: { items: [expect.anything()], nextCursor: expect.any(String) } });
    if (!partialPage.ok || !partialPage.value.nextCursor) throw new Error('Expected an older page');
    const older = await contribution.pageTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture',
      direction: 'older', cursor: partialPage.value.nextCursor, maxItems: 1 });
    expect(older).toMatchObject({ ok: true, value: { items: [{ raw: { role: 'user', content: { text: '  ping  ' } } }], nextCursor: null } });
    expect(older.ok && older.value.items[0]?.id).not.toBe(partialPage.value.items[0]?.id);
  });
  it('keeps unknown versions and stream logs unsupported and confines link paths to the admitted native roots', async () => {
    const { contribution, request, path, body, home } = await fixture();
    await writeFile(path, body.replace('"version":2', '"version":99'));
    expect(await contribution.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'pong' })).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'unsupported' } });
    expect(await contribution.pageTranscript({ ...request, remoteSessionId: 'session-fixture', direction: 'older' })).toMatchObject({ ok: false, code: 'unsupported' });
    await writeFile(path, '{"type":"system","session_id":"stream"}\n');
    expect(await contribution.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'pong' })).toMatchObject({ ok: true, value: { contentCoverage: 'unsupported' } });
    const outside = join(home, 'outside.jsonl');
    await writeFile(outside, body);
    const escape = await contribution.resolveLinkedIdentity({ ...request, remoteSessionId: 'session-fixture', linkData: { sessionFilePath: outside } });
    expect(escape).toMatchObject({ ok: false, code: 'source_invalid' });
    await symlink(outside, path + '.escape.jsonl');
    expect(await contribution.resolveLinkedIdentity({ ...request, remoteSessionId: 'session-fixture', linkData: { sessionFilePath: path + '.escape.jsonl' } })).toMatchObject({ ok: false, code: 'source_invalid' });
  });
  it('projects genuine tool output separately and reports unfamiliar content without searching its native payload', async () => {
    const { contribution, request, path, body } = await fixture();
    // Schema-2 envelope/blocks from the pinned native dialect; payload strings
    // are replaced to discriminate tool output from tool input and unknown bags.
    await writeFile(path, body + JSON.stringify({ type: 'message', id: 'tool', parentId: 'assistant-active',
      timestamp: '2026-07-13T20:20:10.000Z', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call', content: 'true tool output needle' },
        { type: 'new_private_part', text: 'unrecognized hidden payload' },
      ] } }) + '\n');
    const found = await contribution.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'true tool output needle' });
    expect(found).toMatchObject({ ok: true, value: { candidates: [{ match: { snippet: expect.stringContaining('true tool output needle') } }], contentCoverage: 'partial' } });
    const page = await contribution.pageTranscript({ ...request, remoteSessionId: 'session-fixture', direction: 'older' });
    if (!page.ok) throw new Error(page.code);
    expect(page.value.items.at(-1)).toMatchObject({ raw: { role: 'agent', content: { data: { type: 'tool-result', output: 'true tool output needle' } } } });
    expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(page.value.items.at(-1)?.raw).success).toBe(true);
    expect(await contribution.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'unrecognized hidden payload' }))
      .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
  });
  it('does not acknowledge unreadable appended native records as an unchanged transcript', async () => {
    const { contribution, request, path } = await fixture();
    const linked = await contribution.resolveLinkIdentity({ ...request, remoteSessionId: 'session-fixture' });
    if (!linked.ok) throw new Error(linked.code);
    const page = await contribution.pageTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', direction: 'older' });
    if (!page.ok || !page.value.tailCursor) throw new Error('Expected native tail');
    await appendFile(path, '{"type":"new_message_dialect","text":"unreadable appended needle"}\n');
    expect(await contribution.readAfterTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', cursor: page.value.tailCursor }))
      .toMatchObject({ ok: true, value: { outcome: 'read_failed' } });
  });
  it('does not report temporarily unreadable storage as confirmed transcript removal', async () => {
    const { contribution, request, path, body, factoryDir } = await fixture();
    const linked = await contribution.resolveLinkIdentity({ ...request, remoteSessionId: 'session-fixture' });
    if (!linked.ok) throw new Error(linked.code);
    const page = await contribution.pageTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', direction: 'older' });
    if (!page.ok || !page.value.tailCursor) throw new Error('Expected native tail');
    await rm(path);
    expect(await contribution.readAfterTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', cursor: page.value.tailCursor }))
      .toMatchObject({ ok: true, value: { outcome: 'source_unavailable' } });
    await rm(join(factoryDir, 'sessions'), { recursive: true, force: true });
    expect(await contribution.readAfterTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', cursor: page.value.tailCursor }))
      .toMatchObject({ ok: false, code: 'source_unreachable' });
    await mkdir(join(factoryDir, 'sessions', '-workspace'), { recursive: true });
    await writeFile(path, body);
    vi.mocked(nativeFileSystem.realpath).mockRejectedValue(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    expect(await contribution.readAfterTranscript({ ...request, source: linked.value.source, remoteSessionId: 'session-fixture', cursor: page.value.tailCursor }))
      .toMatchObject({ ok: false, code: 'source_unreachable' });
  });
  it('exposes the same file inventory through source observation and makes deadline continuations advance', async () => {
    const { contribution, request, path } = await fixture();
    let parent = 'assistant-active';
    for (let item = 0; item < 40; item += 1) {
      const id = `continued-${item}`;
      await appendFile(path, JSON.stringify(message(id, parent, item === 39 ? 'deadline pong' : 'ordinary answer')) + '\n');
      parent = id;
    }
    const source = await contribution.resolveSource(request);
    expect(source).toMatchObject({ ok: true, value: { accountingSource: { watchFileChanges: { files: [path] } } } });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now += 1);
    const hits = [];
    let partialPages = 0;
    let cursor: string | null = null;
    for (let step = 0; step < 100; step += 1) {
      const result = await contribution.listCandidates({ ...request, searchTarget: 'content', searchTerm: 'pong',
        scanDeadlineAtMs: now + 4, ...(cursor ? { cursor } : {}) });
      if (!result.ok) throw new Error(result.code);
      hits.push(...result.value.candidates);
      if (!result.value.nextCursor) { cursor = null; break; }
      expect(result.value.contentCoverage).toBe('partial');
      partialPages += 1;
      expect(result.value.nextCursor).not.toBe(cursor);
      cursor = result.value.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(partialPages).toBeGreaterThan(1);
    expect(hits).toHaveLength(1);
  });
});
