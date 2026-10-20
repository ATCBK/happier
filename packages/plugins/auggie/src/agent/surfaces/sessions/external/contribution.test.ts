import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { AgentExternalSessionTranscriptRawRecordSchema, type AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activate } from '../../../../activate.js';
import { PLUGIN_MANIFEST } from '../../../../manifest.js';
import { buildAuggieNativeSession } from './__fixtures__/nativeSession.test-support.js';

const roots: string[] = [];
const kits: Awaited<ReturnType<typeof createPluginTestkit>>[] = [];
afterEach(async () => { await Promise.all(kits.splice(0).map(kit => kit.dispose())); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(texts = ['quartz body-only phrase 東京 café "quoted"\nsecond line']) {
  const home = await mkdtemp(join(tmpdir(), 'happier-auggie-reader-')); roots.push(home);
  vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  const directory = join(home, '.augment', 'sessions'); await mkdir(directory, { recursive: true });
  const path = join(directory, 'native-session.json');
  const data = buildAuggieNativeSession(texts); await writeFile(path, JSON.stringify(data));
  const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } }); kits.push(kit);
  const contribution = kit.registration('agents', 'auggie')?.externalSessions;
  expect(contribution, 'Auggie must activate its native reader').toBeDefined();
  if (!contribution) throw new Error('Auggie native reader missing');
  const invocation = { signal: new AbortController().signal, maxSerializedBytes: 1024 * 1024,
    exec: new Proxy({} as AgentExternalSessionsInvocation['exec'], { get() { throw new Error('No vendor process permitted'); } }),
    managedEndpointRead: async () => { throw new Error('No vendor server permitted'); },
    ripgrep: { run: async () => { throw new Error('JSON snapshots use the decoded shared helper'); } },
  } satisfies AgentExternalSessionsInvocation;
  return { contribution, invocation, source: { kind: 'auggieHome' }, path, data, directory };
}
describe('Auggie 0.36.0 native snapshot reader', () => {
  it('searches full decoded bodies through activation and preserves transcript locators without duplicate fallback text', async () => {
    const body = 'prefix '.repeat(1200) + 'quartz 東京 café "quoted"\nsecond line';
    const { contribution: c, invocation: i, source, path, data } = await setup([body]);
    data.chatHistory[0]!.exchange.response_nodes.push(Object.assign({ id: 2, type: 5, content: '' },
      { tool_use: { tool_use_id: 'tool-1', tool_name: 'read-file', input_json: '{"path":"tool-metadata-only phrase"}' } }));
    await writeFile(path, JSON.stringify(data).replaceAll('東京', '\\u6771\\u4eac'));
    const listed = await c.listCandidates({ ...i, source, maxItems: 10, searchTarget: 'content', searchTerm: 'quartz 東京 café' });
    expect(listed).toMatchObject({ ok: true, value: { contentCoverage: 'complete', candidates: [{ match: { snippet: expect.stringContaining('quartz 東京 café') } }] } });
    const page = await c.pageTranscript({ ...i, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    if (!page.ok || !listed.ok) throw new Error('Expected readable fixture');
    expect(page.value.items).toHaveLength(2);
    expect(page.value.items[listed.value.candidates[0]!.match!.messageIndex]!.id).toBe(listed.value.candidates[0]!.match!.sourceItemId);
    for (const item of page.value.items) expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
    expect(await c.listCandidates({ ...i, source, maxItems: 10, searchTarget: 'content', searchTerm: 'tool-metadata-only phrase' })).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
  });
  it('projects actual tool results but excludes metadata and future envelope versions', async () => {
    const { contribution: c, invocation: i, source, path, data } = await setup();
    data.chatHistory[0]!.exchange.request_nodes.push({ id: 2, type: 1,
      tool_result_node: { tool_use_id: 'tool-1', content: 'sapphire result body', is_error: false, metadata: { label: 'metadata secret' } } });
    await writeFile(path, JSON.stringify(data));
    expect(await c.listCandidates({ ...i, source, maxItems: 10, searchTarget: 'content', searchTerm: 'sapphire result body' }))
      .toMatchObject({ ok: true, value: { contentCoverage: 'complete', candidates: [{ match: { snippet: expect.stringContaining('sapphire result body') } }] } });
    expect(await c.listCandidates({ ...i, source, maxItems: 10, searchTarget: 'content', searchTerm: 'metadata secret' }))
      .toMatchObject({ ok: true, value: { contentCoverage: 'complete', candidates: [] } });
    await writeFile(path, JSON.stringify({ ...data, schemaVersion: 999 }));
    expect(await c.listCandidates({ ...i, source, maxItems: 10, searchTarget: 'content', searchTerm: 'quartz' }))
      .toMatchObject({ ok: true, value: { contentCoverage: 'partial', candidates: [] } });
    expect(await c.pageTranscript({ ...i, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 }))
      .toMatchObject({ ok: false, code: 'unsupported' });
  });
  it('matches a body phrase spanning native text nodes without indexing a duplicate fallback', async () => {
    const { contribution: c, invocation: i, source, path, data } = await setup(['violet across nodes']);
    data.chatHistory[0]!.exchange.request_nodes = [
      { id: 1, type: 0, text_node: { content: 'violet across ' } },
      { id: 2, type: 0, text_node: { content: 'nodes' } },
    ];
    await writeFile(path, JSON.stringify(data));
    expect(await c.listCandidates({ ...i, source: { ...source, augmentHome: null }, maxItems: 10, searchTarget: 'content', searchTerm: 'across nodes' }))
      .toMatchObject({ ok: true, value: { contentCoverage: 'complete', candidates: [{ match: { snippet: expect.stringContaining('across nodes') } }] } });
  });
  it('observes native files, advances an append, and resets a rewritten snapshot or compaction', async () => {
    const { contribution: c, invocation: i, source, path, directory } = await setup();
    const resolved = await c.resolveSource({ ...i, source });
    expect(resolved).toMatchObject({ ok: true, value: { accountingSource: { changeObservation: 'watch_file_changes', watchFileChanges: { files: [path], topologyDirectories: [directory] } } } });
    expect(await c.resolveSource({ ...i, source, includeAccountingSource: false })).not.toHaveProperty('value.accountingSource');
    const page = await c.pageTranscript({ ...i, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    if (!page.ok || !page.value.tailCursor) throw new Error('Expected tail');
    await writeFile(path + '.tmp', JSON.stringify(buildAuggieNativeSession(['quartz body-only phrase 東京 café "quoted"\nsecond line', 'garnet appended message'])));
    await rename(path + '.tmp', path);
    const after = await c.readAfterTranscript({ ...i, source, remoteSessionId: 'native-session', cursor: page.value.tailCursor, maxItems: 100 });
    expect(after).toMatchObject({ ok: true, value: { outcome: 'advanced', items: expect.any(Array) } });
    if (!after.ok || after.value.outcome !== 'advanced') throw new Error('Expected append');
    expect(JSON.stringify(after.value.items)).toContain('garnet');
    await writeFile(path, JSON.stringify(buildAuggieNativeSession(['amethyst replacement text'])));
    expect(await c.readAfterTranscript({ ...i, source, remoteSessionId: 'native-session', cursor: after.value.nextCursor, maxItems: 100 })).toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
    const compacted = buildAuggieNativeSession(['model-only summary']); Object.assign(compacted.chatHistory[0]!, { isHistorySummary: true, historySummaryVersion: 1 });
    await writeFile(path, JSON.stringify(compacted));
    expect(await c.listCandidates({ ...i, source, maxItems: 10, searchTarget: 'content', searchTerm: 'model-only summary' })).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
  });
  it('excludes backups and temporary snapshots and preserves missing/malformed source failures', async () => {
    const { contribution: c, invocation: i, source, path, directory, data } = await setup();
    await writeFile(join(directory, 'native-session-backup1.json'), JSON.stringify(data)); await writeFile(path + '.tmp', JSON.stringify(data));
    expect(await c.listCandidates({ ...i, source, maxItems: 10 })).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: 'native-session' }], nextCursor: null } });
    await writeFile(path, '{');
    expect(await c.listCandidates({ ...i, source, maxItems: 10, searchTarget: 'content', searchTerm: 'quartz' })).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    await rm(directory, { recursive: true });
    expect(await c.listCandidates({ ...i, source, maxItems: 10 })).toMatchObject({ ok: false });
  });
  it('returns honest partial for unknown node shapes and rejects symlink escapes and cancellation', async () => {
    const { contribution: c, invocation: i, source, path, data, directory } = await setup();
    data.chatHistory[0]!.exchange.response_nodes.push({ id: 8, type: 999, content: 'unknown content' });
    await writeFile(path, JSON.stringify(data));
    expect(await c.listCandidates({ ...i, source, maxItems: 10, searchTarget: 'content', searchTerm: 'unknown content' })).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    const page = await c.pageTranscript({ ...i, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    expect(page.ok && JSON.stringify(page.value.items)).toContain('unsupported content block');
    expect(page).not.toHaveProperty('value.truncated');
    expect(await c.listCandidates({ ...i, source, maxItems: 10, searchTarget: 'content', searchTerm: 'quartz' }))
      .toMatchObject({ ok: true, value: { candidates: [{ match: { snippet: expect.stringContaining('quartz') } }], contentCoverage: 'partial' } });
    expect(await c.listCandidates({ ...i, source, maxItems: 10, searchTarget: 'content', searchTerm: 'unsupported content block' }))
      .toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    const controller = new AbortController(); controller.abort();
    expect(await c.listCandidates({ ...i, source, signal: controller.signal, maxItems: 10 })).toMatchObject({ ok: false, code: 'cancelled' });
    const outside = join(directory, '..', 'outside.json'); await writeFile(outside, await readFile(path)); await rm(path); await symlink(outside, path);
    expect(await c.pageTranscript({ ...i, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 })).toMatchObject({ ok: false, code: 'source_invalid' });
  });
  it('pages within the caller byte budget and fails explicitly for an indivisible oversized body', async () => {
    const { contribution: c, invocation: i, source, path } = await setup(Array.from({ length: 30 }, (_, n) => `native row ${n}`));
    const page = await c.pageTranscript({ ...i, maxSerializedBytes: 2000, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    expect(page).toMatchObject({ ok: true, value: { hasMore: true, nextCursor: expect.any(String) } });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2000);
    await writeFile(path, JSON.stringify(buildAuggieNativeSession(['large body '.repeat(1000)])));
    expect(await c.pageTranscript({ ...i, maxSerializedBytes: 2000, source, remoteSessionId: 'native-session', direction: 'newer', maxItems: 100 }))
      .toMatchObject({ ok: false, code: 'agent_error' });
  });
  it('resumes deadline-limited content scans with stable page cursors and query binding', async () => {
    const { contribution: c, invocation: i, source } = await setup(['quartz early', 'middle', 'quartz late']);
    let cursor: string | undefined; let found = false;
    for (let step = 0; step < 12; step++) {
      const result = await c.listCandidates({ ...i, source, maxItems: 10, cursor, searchTarget: 'content', searchTerm: 'quartz', scanDeadlineAtMs: Date.now() - 1 });
      if (!result.ok) throw new Error(result.code);
      if (step === 0) expect(result.value).toMatchObject({ contentCoverage: 'partial', nextCursor: expect.any(String) });
      found ||= result.value.candidates.length > 0;
      if (!result.value.nextCursor) break;
      expect(result.value.nextCursor).not.toBe(cursor); cursor = result.value.nextCursor;
    }
    expect(found).toBe(true);
    expect(await c.listCandidates({ ...i, source, maxItems: 10, cursor, searchTarget: 'content', searchTerm: 'different' })).toMatchObject({ ok: false, code: 'source_invalid' });
    const page = await c.pageTranscript({ ...i, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 2 });
    if (!page.ok || !page.value.nextCursor) throw new Error('Expected older continuation');
    const older = await c.pageTranscript({ ...i, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 2, cursor: page.value.nextCursor });
    if (!older.ok) throw new Error(older.code);
    expect(older.value.items.map(item => item.id)).not.toEqual(page.value.items.map(item => item.id));
  });
});
