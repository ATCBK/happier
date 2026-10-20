import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExternalSessionsContribution, AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { KILO_PLUGIN } from '../../manifest.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

type Fixture = { session: { id: string; version: string; time: { created: number; updated: number }; revert?: { messageID: string; partID?: string } };
  messages: { id: string; sessionID: string; role: string; time: { created: number } }[];
  parts: { id: string; sessionID: string; messageID: string; type: string; text?: string }[] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-kilo-reader-')); roots.push(root);
  const data: Fixture = JSON.parse(await readFile(new URL('./__fixtures__/kilo-json-1.0.25.json', import.meta.url), 'utf8'));
  const put = async (path: string, value: unknown) => { await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value).replaceAll('東京', '\\u6771\\u4eac')); };
  const sessionPath = join(root, 'session', 'project', 'ses_fixture.json');
  await put(sessionPath, data.session);
  for (const message of data.messages) await put(join(root, 'message', message.sessionID, `${message.id}.json`), message);
  for (const part of data.parts) await put(join(root, 'part', part.messageID, `${part.id}.json`), part);
  const registered: AgentExternalSessionsContribution[] = [];
  // Real activate ABI; only the host registration boundary is captured.
  await KILO_PLUGIN.activate({ agents: { register: () => {},
    registerExternalSessions: (_id: string, contribution: AgentExternalSessionsContribution) => registered.push(contribution),
  } } as Parameters<typeof KILO_PLUGIN.activate>[0]);
  expect(registered, 'Kilo must register a consumed native transcript reader').toHaveLength(1);
  const invocation = { signal: new AbortController().signal, maxSerializedBytes: 1_048_576,
    managedEndpointRead: async () => { throw new Error('No vendor server reads'); },
    exec: { run: async () => { throw new Error('No vendor process launches'); } },
    ripgrep: { run: async () => { throw new Error('Decoded JSON parts are the search authority'); } },
  } as AgentExternalSessionsInvocation;
  return { root, data, put, sessionPath, reader: registered[0]!, request: { ...invocation, source: { kind: 'kiloStorage', storageRoot: root }, maxItems: 100 } };
}

describe('registered Kilo JSON history', () => {
  it('observes the complete source, honors admission-only resolution, and binds continuations to the source and query', async () => {
    const f = await fixture();
    const resolved = await f.reader.resolveSource(f.request);
    expect(resolved).toMatchObject({ ok: true, value: { accountingSource: {
      rootPath: f.root, rootField: 'storageRoot', changeObservation: 'watch_file_changes',
      watchFileChanges: { topologyDirectories: [f.root], files: expect.arrayContaining([
        f.sessionPath, join(f.root, 'message', 'ses_fixture', 'msg_02.json'), join(f.root, 'part', 'msg_02', 'prt_03.json'),
      ]) },
    } } });
    expect(await f.reader.resolveSource({ ...f.request, includeAccountingSource: false })).toEqual({ ok: true, value: { source: f.request.source } });
    const identity = await f.reader.resolveLinkIdentity({ ...f.request, remoteSessionId: 'ses_fixture' });
    expect(identity).toMatchObject({ ok: true, value: { source: f.request.source, remoteSessionId: 'ses_fixture' } });
    const page = await f.reader.pageTranscript({ ...f.request, maxItems: 1, remoteSessionId: 'ses_fixture', direction: 'older' });
    expect(page.ok).toBe(true); if (!page.ok) return;
    const otherRoot = await mkdtemp(join(tmpdir(), 'happier-kilo-other-')); roots.push(otherRoot);
    expect(await f.reader.readAfterTranscript({ ...f.request, source: { kind: 'kiloStorage', storageRoot: otherRoot },
      remoteSessionId: 'ses_fixture', cursor: page.value.tailCursor! })).not.toMatchObject({ ok: true, value: { outcome: 'advanced' } });
    const bounded = await f.reader.pageTranscript({ ...f.request, maxSerializedBytes: 750, remoteSessionId: 'ses_fixture', direction: 'older' });
    expect(bounded.ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(750);
  });

  it('finds body-only escaped, non-ASCII and long text with exact ordered transcript locators, excluding tool metadata', async () => {
    const f = await fixture();
    const long = 'x'.repeat(12_000) + ' distantbody';
    await f.put(join(f.root, 'part', 'msg_02', 'prt_05.json'), { id: 'prt_05', sessionID: 'ses_fixture', messageID: 'msg_02', type: 'text', text: long });
    const page = await f.reader.pageTranscript({ ...f.request, remoteSessionId: 'ses_fixture', direction: 'older' });
    expect(page.ok).toBe(true); if (!page.ok) return;
    expect(page.value.items.every(item => AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success)).toBe(true);
    expect(page.value.items.map(item => item.id)).toEqual(['prt_01', 'prt_02', 'prt_03', 'prt_04:call', 'prt_04', 'prt_05']);
    for (const searchTerm of ['body-only phrase', '"quotes"\n東京', '東京 café', 'distantbody', 'visible tool result']) {
      const hits = await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm });
      expect(hits).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: 'ses_fixture', match: {
        snippet: expect.stringContaining(searchTerm), sourceItemId: expect.any(String) } }], contentCoverage: 'complete' } });
      if (hits.ok) expect(page.value.items[hits.value.candidates[0]!.match!.messageIndex]!.id).toBe(hits.value.candidates[0]!.match!.sourceItemId);
    }
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'metadata-only phrase' }))
      .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
  });

  it('pages backward and detects same-message edits and revert before read-after can append abandoned text', async () => {
    const f = await fixture();
    const page = await f.reader.pageTranscript({ ...f.request, maxItems: 3, remoteSessionId: 'ses_fixture', direction: 'older' });
    expect(page.ok).toBe(true); if (!page.ok) return;
    expect(page.value.items.map(i => i.id)).toEqual(['prt_03', 'prt_04:call', 'prt_04']);
    const older = await f.reader.pageTranscript({ ...f.request, maxItems: 3, remoteSessionId: 'ses_fixture', direction: 'older', cursor: page.value.nextCursor! });
    expect(older.ok && older.value.items.map(i => i.id)).toEqual(['prt_01', 'prt_02']);
    await f.put(join(f.root, 'part', 'msg_02', 'prt_05.json'), { id: 'prt_05', sessionID: 'ses_fixture', messageID: 'msg_02', type: 'text', text: 'garnet appended message' });
    const appended = await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: 'ses_fixture', cursor: page.value.tailCursor! });
    expect(appended).toMatchObject({ ok: true, value: { outcome: 'advanced', items: [{ id: 'prt_05' }] } });
    await f.put(join(f.root, 'part', 'msg_02', 'prt_03.json'), { ...f.data.parts[1], text: 'rewritten settled body' });
    expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: 'ses_fixture', cursor: page.value.tailCursor! }))
      .toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
    await f.put(f.sessionPath, { ...f.data.session, revert: { messageID: 'msg_02', partID: 'prt_03' } });
    const reverted = await f.reader.pageTranscript({ ...f.request, remoteSessionId: 'ses_fixture', direction: 'older' });
    expect(reverted.ok && reverted.value.items.map(i => i.id)).toEqual(['prt_01']);
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'garnet' }))
      .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
  });

  it('yields partial search pages under caller deadlines and continues without losing a body hit', async () => {
    const f = await fixture(); let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1));
    let cursor: string | undefined; let hit = false; let partial = false;
    for (let round = 0; round < 20; round++) {
      const page = await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'body-only',
        scanDeadlineAtMs: clock + 4, ...(cursor ? { cursor } : {}) });
      expect(page.ok).toBe(true); if (!page.ok) return;
      hit ||= page.value.candidates.length > 0;
      partial ||= page.value.contentCoverage === 'partial';
      if (!page.value.nextCursor) { cursor = undefined; break; }
      expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'different query', cursor: page.value.nextCursor }))
        .toMatchObject({ ok: false, code: 'source_invalid' });
      expect(page.value.nextCursor).not.toBe(cursor); cursor = page.value.nextCursor;
    }
    expect(partial).toBe(true); expect(hit).toBe(true); expect(cursor).toBeUndefined();
  });

  it('reports unknown versions and missing parts as incomplete, and confines ids and symlinks', async () => {
    const f = await fixture();
    await f.put(f.sessionPath, { ...f.data.session, version: '99.0.0' });
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'quartz' }))
      .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    const unknown = await f.reader.pageTranscript({ ...f.request, remoteSessionId: 'ses_fixture', direction: 'older' });
    expect(unknown.ok && unknown.value.truncated).toBe(true);
    await f.put(f.sessionPath, f.data.session);
    await rm(join(f.root, 'part', 'msg_02'), { recursive: true });
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'missing' }))
      .toMatchObject({ ok: true, value: { contentCoverage: 'partial' } });
    expect(await f.reader.pageTranscript({ ...f.request, remoteSessionId: '../escape', direction: 'older' })).toMatchObject({ ok: false, code: 'invalid_request' });
    await symlink(tmpdir(), join(f.root, 'part', 'msg_02'), 'dir');
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'missing' }))
      .toMatchObject({ ok: false, code: 'source_invalid' });
    const controller = new AbortController(); controller.abort();
    expect(await f.reader.listCandidates({ ...f.request, signal: controller.signal })).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('does not silently accept future content fields in the pinned dialect', async () => {
    const f = await fixture();
    const initial = await f.reader.pageTranscript({ ...f.request, remoteSessionId: 'ses_fixture', direction: 'older' });
    expect(initial.ok).toBe(true); if (!initial.ok) return;
    await f.put(join(f.root, 'part', 'msg_02', 'prt_03.json'), { ...f.data.parts[1], futureVisibility: 'hidden' });
    expect(await f.reader.listCandidates({ ...f.request, searchTarget: 'content', searchTerm: 'body-only' }))
      .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    expect(await f.reader.readAfterTranscript({ ...f.request, remoteSessionId: 'ses_fixture', cursor: initial.value.tailCursor! }))
      .toMatchObject({ ok: true, value: { outcome: 'read_failed' } });
  });
});
