import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentExternalSessionsInvocation, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { activate } from '../../activate.js';
import { createDevinNativeFixture } from './__fixtures__/nativeSession.test-support.js';

// Actual copy is retained. This OS-boundary hook controls only the vendor-close
// and torn-copy interleavings, never the decoder/search/SQLite logic.
const copyBoundary = vi.hoisted(() => ({ afterCopy: null as null | ((source: string, destination: string, elapsedMs: number) => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
    const started = performance.now();
    await actual.copyFile(...args);
    await copyBoundary.afterCopy?.(String(args[0]), String(args[1]), performance.now() - started);
  } };
});
const invocation = (): AgentExternalSessionsInvocation => ({
  signal: new AbortController().signal,
  // Process/transport boundaries must remain unused for native byte reads.
  exec: {} as AgentExternalSessionsInvocation['exec'],
  ripgrep: { run: async () => { throw new Error('No native SQL prefilter'); } },
  managedEndpointRead: async () => { throw new Error('No vendor endpoint'); },
});
function value<T>(result: AgentExternalSessionsResult<T>): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
async function fixture(work: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await work(f); } finally { copyBoundary.afterCopy = null; f.native.close(); await f.activation.dispose(); await rm(f.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'happier-devin-reader-'));
  const native = createDevinNativeFixture(root);
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } }).catch(async error => {
    native.close(); await rm(root, { recursive: true, force: true }); throw error;
  });
  const reader = activation.registration('agents', 'devin')?.externalSessions;
  if (!reader) { native.close(); await activation.dispose(); await rm(root, { recursive: true }); throw new Error('Missing native reader'); }
  const source = { kind: 'devinHome', devinHome: root };
  const list = (query: string, extra = {}) => reader.listCandidates({ ...invocation(), source,
    searchTarget: 'content', searchTerm: query, maxItems: 1, maxSerializedBytes: 100_000, ...extra });
  const page = (extra = {}) => reader.pageTranscript({ ...invocation(), source, remoteSessionId: native.sessionId,
    direction: 'older', maxItems: 20, maxSerializedBytes: 100_000, ...extra });
  const after = (cursor: string) => reader.readAfterTranscript({ ...invocation(), source,
    remoteSessionId: native.sessionId, cursor, maxItems: 20, maxSerializedBytes: 100_000 });
  const snapshot = async () => Object.fromEntries(await Promise.all((await readdir(root)).sort().map(async name => [name, await readFile(join(root, name))])));
  return { root, native, activation, reader, source, list, page, after, snapshot };
}
describe('activated Devin schema-16 native reader', () => {
  it('searches active decoded bodies and tool results, excluding metadata and abandoned branches', async () => fixture(async f => {
    f.native.append('assistant body', 'assistant', { thinking: { thinking: 'private reasoning needle' },
      tool_calls: [{ id: 'call-1', kind: 'function', name: 'read', index: 0, arguments: { path: 'metadata-only-needle' } }] });
    f.native.append('visible tool output', 'tool', { tool_call_id: 'call-1' });
    f.native.db.prepare('INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) VALUES (?,99,1,?,?)')
      .run(f.native.sessionId, JSON.stringify({ message_id: 'abandoned', role: 'user', content: 'abandoned needle' }), Math.floor(Date.now()/1000));
    for (const query of ['body-only harbor', 'café 😀\nquoted "text"', 'visible tool output']) {
      const result = value(await f.list(query));
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.match?.snippet).toContain(query);
    }
    for (const query of ['metadata-only-needle', 'private reasoning needle', 'abandoned needle']) expect(value(await f.list(query)).candidates).toEqual([]);
    const transcript = value(await f.page());
    for (const item of transcript.items) expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
    expect(transcript.items[0]?.id).toBe(value(await f.list('harbor')).candidates[0]?.match?.sourceItemId);
  }));
  it('preserves every vendor byte and entry with WAL-only commits and across writer close', async () => fixture(async f => {
    f.native.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const base = await readFile(f.native.path);
    f.native.append('wal-only garnet');
    expect(await readFile(f.native.path)).toEqual(base);
    const before = await f.snapshot();
    expect(value(await f.list('wal-only garnet')).candidates).toHaveLength(1);
    expect(await f.snapshot()).toEqual(before);
    f.native.append('later jade');
    expect(value(await f.list('later jade')).candidates).toHaveLength(1);
    // A real writer commits after the DB bytes are copied but before the WAL
    // copy. Compare against its post-commit bytes so reader writes cannot hide
    // behind the expected vendor mutation.
    let committed: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    copyBoundary.afterCopy = async source => {
      if (source === f.native.path) { f.native.append('during-copy emerald'); committed = await f.snapshot(); }
    };
    expect(value(await f.list('during-copy emerald')).candidates).toHaveLength(1);
    expect(await f.snapshot()).toEqual(committed);
    // Close between byte-copy admission and SQLite open, deterministically.
    let closed: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    copyBoundary.afterCopy = async source => {
      if (source === f.native.path + '-wal') { f.native.close(); closed = await f.snapshot(); }
    };
    expect(value(await f.page()).items).toHaveLength(4);
    expect(closed).toBeDefined();
    expect(await f.snapshot()).toEqual(closed);
    // fixture finalizer can close idempotently.
  }));
  it('reads a committed prefix or reports incomplete when a copied WAL has a torn tail', async () => fixture(async f => {
    f.native.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    f.native.append('uncheckpointed garnet');
    const before = await f.snapshot();
    const copies: string[] = [];
    copyBoundary.afterCopy = async (source, destination) => {
      copies.push(destination);
      if (source.endsWith('-wal')) {
        const bytes = await readFile(destination);
        await writeFile(destination, bytes.subarray(0, bytes.length - 37));
      }
    };
    const result = await f.page();
    if (result.ok) {
      expect(result.value.items.length > 0 || result.value.truncated).toBe(true);
      expect(JSON.stringify(result.value.items)).toContain('body-only harbor');
    } else expect(['unavailable', 'unsupported']).toContain(result.code);
    expect(await f.snapshot()).toEqual(before);
    copyBoundary.afterCopy = null;
    for (const path of copies) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  it('cancels during a byte copy and removes private data without touching the vendor store', async () => fixture(async f => {
    const controller = new AbortController();
    const before = await f.snapshot();
    let copiedPath: string | undefined;
    copyBoundary.afterCopy = async (_source, destination) => { copiedPath = destination; controller.abort(); };
    expect(await f.page({ signal: controller.signal })).toMatchObject({ ok: false, code: 'cancelled' });
    expect(copiedPath).toBeDefined();
    copyBoundary.afterCopy = null;
    await expect(readFile(copiedPath!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.snapshot()).toEqual(before);
  }));
  it('pages, follows appends, rejects rewrites and retains unavailable history', async () => fixture(async f => {
    const initial = value(await f.page());
    f.native.append('garnet append');
    expect(value(await f.after(initial.tailCursor!))).toMatchObject({ outcome: 'advanced', items: [expect.anything()] });
    const newest = value(await f.page({ maxItems: 1 }));
    expect(value(await f.page({ maxItems: 1, cursor: newest.nextCursor })).items[0]?.id).toBe(initial.items[0]?.id);
    f.native.db.prepare('UPDATE message_nodes SET chat_message=? WHERE node_id=1').run(JSON.stringify({ message_id: 'message-1', role: 'user', content: 'replacement opal' }));
    expect(value(await f.after(initial.tailCursor!))).toEqual({ outcome: 'source_replaced' });
    f.native.db.prepare('UPDATE sessions SET hidden=1').run();
    expect(value(await f.list('opal')).candidates).toEqual([]);
    expect(value(await f.after(newest.tailCursor!))).toEqual({ outcome: 'source_unavailable' });
    f.native.close();
    await rename(f.native.path, join(f.root, 'retained.db'));
    expect(await f.after(initial.tailCursor!)).toMatchObject({ ok: false, code: 'unavailable' });
  }));
  it('guards unknown schemas, fields and broken ancestry with honest partial coverage', async () => fixture(async f => {
    f.native.append('unknown field secret', 'user', { futureRewrite: true });
    expect(value(await f.list('unknown field secret'))).toMatchObject({ candidates: [], contentCoverage: 'partial' });
    f.native.append('unknown secret', 'future-role');
    expect(value(await f.list('unknown secret'))).toMatchObject({ candidates: [], contentCoverage: 'partial' });
    expect(value(await f.page()).truncated).toBe(true);
    f.native.db.prepare('UPDATE message_nodes SET parent_node_id=999 WHERE node_id=1').run();
    expect(value(await f.list('harbor'))).toMatchObject({ candidates: [], contentCoverage: 'partial' });
    f.native.db.prepare("INSERT INTO refinery_schema_history VALUES (17,'future','now','future')").run();
    expect(await f.page()).toMatchObject({ ok: false, code: 'unsupported' });
    expect(await f.list('harbor')).toMatchObject({ ok: false, code: 'unsupported' });
  }));
  it('reads long bodies within caller budgets and measures a 64 MiB native copy without a new limit', async () => fixture(async f => {
    f.native.append('x'.repeat(20_000) + ' long-tail needle');
    expect(value(await f.list('long-tail needle')).candidates).toHaveLength(1);
    expect(await f.page({ maxSerializedBytes: 100 })).toMatchObject({ ok: false, code: 'agent_error' });
    // Realistic store volume without carrying anyone's private history.
    f.native.db.prepare("INSERT INTO app_state VALUES ('synthetic-volume',zeroblob(?))").run(64 * 1024 * 1024);
    f.native.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = (await stat(f.native.path)).size;
    const copies: { file: string; elapsedMs: number }[] = [];
    copyBoundary.afterCopy = async (source, _destination, elapsedMs) => { copies.push({ file: source.endsWith('-wal') ? 'wal' : 'db', elapsedMs }); };
    const started = performance.now();
    expect(value(await f.page()).items).toHaveLength(2);
    console.info(JSON.stringify({ measurement: 'devin-private-copy-and-page', databaseBytes: bytes, copies, elapsedMs: performance.now() - started }));
  }));
  it('observes DB and WAL through source-wide registration and resumes deadline pages', async () => fixture(async f => {
    const resolved = value(await f.reader.resolveSource({ ...invocation(), source: f.source }));
    expect(resolved.accountingSource?.watchFileChanges).toEqual({
      files: [f.native.path, f.native.path + '-wal'], topologyDirectories: [f.root],
    });
    expect(value(await f.reader.resolveSource({ ...invocation(), source: f.source, includeAccountingSource: false })).accountingSource).toBeUndefined();
    f.native.db.prepare("INSERT INTO sessions SELECT 'second-session',working_directory,backend_type,model,agent_mode,created_at,last_activity_at,title,1,0,NULL,NULL,0,NULL FROM sessions WHERE id=?").run(f.native.sessionId);
    f.native.db.prepare("INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at) SELECT 'second-session',node_id,parent_node_id,chat_message,created_at FROM message_nodes WHERE session_id=?").run(f.native.sessionId);
    const first = value(await f.list('harbor', { scanDeadlineAtMs: 0 }));
    expect(first).toMatchObject({ nextCursor: expect.any(String), contentCoverage: 'partial' });
    const second = value(await f.list('harbor', { cursor: first.nextCursor, scanDeadlineAtMs: 0 }));
    expect([...first.candidates, ...second.candidates]).toHaveLength(2);
    expect((await f.list('other', { cursor: first.nextCursor })).ok).toBe(false);
    const controller = new AbortController(); controller.abort();
    expect(await f.list('harbor', { signal: controller.signal })).toMatchObject({ ok: false, code: 'cancelled' });
  }));
});
