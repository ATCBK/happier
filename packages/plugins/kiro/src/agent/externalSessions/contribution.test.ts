import { appendFile, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExternalSessionsInvocation, AgentExternalSessionsResult } from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { createKiroChatV1Fixture } from './__fixtures__/kiroChatV1.test-support.js';
import { createKiroExternalSessionsContribution } from './contribution.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function value<T>(result: AgentExternalSessionsResult<T>): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.value;
}
const invocation = (): AgentExternalSessionsInvocation => ({
  signal: new AbortController().signal,
  managedEndpointRead: async () => { throw new Error('No endpoint needed for native files'); },
  exec: {} as AgentExternalSessionsInvocation['exec'], // Boundary fixture: native file reads never execute a process.
  ripgrep: { run: async () => { throw new Error('Decoded scan needs no prefilter'); } },
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'happier-kiro-v1-')); roots.push(home);
  const fixture = await createKiroChatV1Fixture({ home });
  const contribution = createKiroExternalSessionsContribution({ env: { KIRO_HOME: home } });
  const source = value(await contribution.resolveSource({ ...invocation(), source: { kind: 'kiroChatStore' } })).source;
  const list = (searchTerm: string, extra = {}) => contribution.listCandidates({ ...invocation(), source, searchTarget: 'content', searchTerm, maxItems: 2, maxSerializedBytes: 100_000, ...extra });
  const page = (extra = {}) => contribution.pageTranscript({ ...invocation(), source, remoteSessionId: fixture.sessionId, direction: 'older', maxItems: 20, maxSerializedBytes: 100_000, ...extra });
  return { ...fixture, home, contribution, source, list, page };
}
describe('Kiro native v1 chat-store contribution', () => {
  it('resolves the nullable default root declared by its source schema', async () => {
    const f = await setup();
    expect(value(await f.contribution.resolveSource({ ...invocation(), source: { kind: 'kiroChatStore', kiroHome: null }, includeAccountingSource: false })).source).toEqual(f.source);
  });
  it('finds full decoded bodies, Unicode and tool outputs, excluding tool inputs and thinking', async () => {
    const f = await setup();
    for (const query of ['body-only harbor', 'café 😀\nquoted "text"', 'visible tool output']) {
      const listed = value(await f.list(query));
      expect(listed.candidates).toHaveLength(1);
      expect(listed.candidates[0]?.match?.snippet).toContain(query);
    }
    for (const query of ['metadata-only-needle', 'private reasoning needle']) expect(value(await f.list(query)).candidates).toEqual([]);
    await createKiroChatV1Fixture({ home: f.home, prompt: `${'x'.repeat(12_000)} long-tail phrase` });
    expect(value(await f.list('long-tail phrase')).candidates).toHaveLength(1);
    const transcript = value(await f.page());
    for (const item of transcript.items) expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
    expect(transcript.items[0]?.id).toBe(value(await f.list('long-tail phrase')).candidates[0]?.match?.sourceItemId);
    expect(JSON.stringify(transcript.items)).toContain('tool-result');
    expect(JSON.stringify(transcript.items)).toContain('t1');
    expect(JSON.stringify(transcript.items)).not.toContain('metadata-only-needle');
  });

  it('paginates and detects prefix rewrites rather than appending abandoned content', async () => {
    const f = await setup();
    const newest = value(await f.page({ maxItems: 1 }));
    const older = value(await f.page({ maxItems: 1, cursor: newest.nextCursor }));
    expect(older.items[0]?.id).not.toBe(newest.items[0]?.id);
    const initial = value(await f.page());
    const row = { version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'appended harbor' }] } };
    await appendFile(f.transcriptPath, `${JSON.stringify(row)}\n`);
    const appended = value(await f.contribution.readAfterTranscript({ ...invocation(), source: f.source, remoteSessionId: f.sessionId, cursor: initial.tailCursor!, maxItems: 10, maxSerializedBytes: 100_000 }));
    expect(appended).toMatchObject({ outcome: 'advanced', hasMore: false });
    if (appended.outcome === 'advanced') expect(JSON.stringify(appended.items)).toContain('appended harbor');
    await writeFile(f.transcriptPath, `${JSON.stringify(row)}\n`);
    expect(value(await f.contribution.readAfterTranscript({ ...invocation(), source: f.source, remoteSessionId: f.sessionId, cursor: initial.tailCursor!, maxItems: 10, maxSerializedBytes: 100_000 }))).toEqual({ outcome: 'source_replaced' });
    expect(value(await f.list('body-only harbor')).candidates).toEqual([]);
  });

  it('observes paired metadata and body plus topology, honoring discovery-only admission', async () => {
    const f = await setup();
    const resolved = value(await f.contribution.resolveSource({ ...invocation(), source: f.source }));
    expect(resolved.accountingSource?.watchFileChanges).toMatchObject({ files: expect.arrayContaining([f.metadataPath, f.transcriptPath]), topologyDirectories: [f.root] });
    expect(value(await f.contribution.resolveSource({ ...invocation(), source: f.source, includeAccountingSource: false })).accountingSource).toBeUndefined();
    const initial = value(await f.page());
    await writeFile(f.metadataPath, JSON.stringify({ ...f.metadata, title: 'Renamed title' }));
    expect(value(await f.contribution.readAfterTranscript({ ...invocation(), source: f.source, remoteSessionId: f.sessionId, cursor: initial.tailCursor!, maxItems: 10, maxSerializedBytes: 100_000 }))).toEqual({ outcome: 'already_current' });
    await writeFile(f.metadataPath, JSON.stringify({ ...f.metadata, parent_session_id: '11111111-1111-4111-8111-111111111111' }));
    expect(value(await f.list('harbor')).candidates).toEqual([]);
    await unlink(f.metadataPath);
    expect(value(await f.list('harbor')).candidates).toEqual([]);
    expect((await f.page()).ok).toBe(false);
  });

  it('reports unknown record versions and images as partial without disclosing unknown bodies', async () => {
    const f = await setup();
    await appendFile(f.transcriptPath, `${JSON.stringify({ version: 'v2', kind: 'Prompt', data: { content: [{ kind: 'text', data: 'secret-unknown' }] } })}\n`);
    expect(value(await f.list('secret-unknown'))).toMatchObject({ candidates: [], contentCoverage: 'partial' });
    const transcript = value(await f.page());
    expect(transcript.truncated).toBe(true);
    expect(JSON.stringify(transcript.items)).toContain('unsupported content block');
    expect(JSON.stringify(transcript.items)).not.toContain('secret-unknown');
    await appendFile(f.transcriptPath, `${JSON.stringify({ version: 'v1', kind: 'Prompt', data: { content: [{ kind: 'image', data: 'private-image-bytes' }] } })}\n`);
    expect(JSON.stringify(value(await f.page()))).not.toContain('private-image-bytes');
    expect((await f.contribution.resolveSource({ ...invocation(), source: { kind: 'kiroAcpV3' } })).ok).toBe(false);
  });

  it('keeps unknown record fields partial and missing bodies unavailable', async () => {
    const f = await setup();
    await appendFile(f.transcriptPath, `${JSON.stringify({ version: 'v1', kind: 'Prompt', futureRewrite: true, data: { content: [{ kind: 'text', data: 'unrecognized-semantics' }] } })}\n`);
    expect(value(await f.list('unrecognized-semantics'))).toMatchObject({ candidates: [], contentCoverage: 'partial' });
    await unlink(f.transcriptPath);
    expect(value(await f.list('body-only harbor'))).toMatchObject({ candidates: [], contentCoverage: 'partial' });
    expect(await f.page()).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('continues an expired cooperative scan and binds its cursor to the query', async () => {
    const f = await setup();
    await createKiroChatV1Fixture({ home: f.home, sessionId: '11111111-1111-4111-8111-111111111111' });
    const first = value(await f.list('harbor', { scanDeadlineAtMs: 0 }));
    expect(first).toMatchObject({ contentCoverage: 'partial', nextCursor: expect.any(String) });
    const next = value(await f.list('harbor', { cursor: first.nextCursor, scanDeadlineAtMs: 0 }));
    expect([...first.candidates, ...next.candidates].map(candidate => candidate.remoteSessionId)).toHaveLength(2);
    expect((await f.list('changed query', { cursor: first.nextCursor })).ok).toBe(false);
    const controller = new AbortController(); controller.abort();
    expect(await f.list('harbor', { signal: controller.signal })).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('rejects escaped symlink files and preserves unavailable versus complete-empty', async () => {
    const f = await setup();
    const other = await mkdtemp(join(tmpdir(), 'happier-kiro-outside-')); roots.push(other);
    const target = join(other, 'secret.jsonl'); await writeFile(target, 'secret');
    await unlink(f.transcriptPath); await symlink(target, f.transcriptPath);
    expect((await f.page()).ok).toBe(false);
    expect(value(await f.list('secret')).contentCoverage).toBe('partial');
    await rm(f.root, { recursive: true });
    expect(await f.list('harbor')).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('retains history when the whole store is unavailable and retires only a missing session in an available store', async () => {
    const f = await setup();
    const initial = value(await f.page());
    const readAfter = () => f.contribution.readAfterTranscript({ ...invocation(), source: f.source, remoteSessionId: f.sessionId, cursor: initial.tailCursor!, maxItems: 10, maxSerializedBytes: 100_000 });
    const retainedRoot = `${f.root}.retained`;
    await rename(f.root, retainedRoot);
    expect(await readAfter()).toMatchObject({ ok: false, code: 'unavailable' });
    await rename(retainedRoot, f.root);
    await unlink(f.transcriptPath);
    expect(value(await readAfter())).toEqual({ outcome: 'source_unavailable' });
  });
});
