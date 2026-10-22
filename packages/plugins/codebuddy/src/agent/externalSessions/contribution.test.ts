import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import * as nativeFileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentExternalSessionTranscriptRawRecordSchema, type AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { createCodeBuddyExternalSessionsContribution } from './contribution.js';

// Permission failure is an OS boundary; admission, parsing and continuation stay real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(nativeFileSystem.stat).mockReset().mockImplementation(actual.stat);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'codebuddy-reader-')); roots.push(home);
  const project = join(home, 'projects', 'fixture-workspace'); await mkdir(project, { recursive: true });
  const file = join(project, 'fixture-session.jsonl');
  await copyFile(fileURLToPath(new URL('./__fixtures__/codebuddy-2.170.0-producer.jsonl', import.meta.url)), file);
  const contribution = createCodeBuddyExternalSessionsContribution({ CODEBUDDY_CONFIG_DIR: home });
  const source = { kind: 'codebuddyHome' };
  // These execution/network boundaries must remain unused by a native file reader.
  const forbidden = () => { throw new Error('Native reader attempted process/network execution'); };
  const invocation = { signal: new AbortController().signal, maxSerializedBytes: 1024 * 1024,
    managedEndpointRead: forbidden, ripgrep: { run: async () => ({ exitCode: 0, stdout: `${file}\0`, stderr: '' }) },
    // Host execution is outside this reader; the trap verifies it is never consulted.
    exec: new Proxy({} as AgentExternalSessionsInvocation['exec'], { get: forbidden }),
  } satisfies AgentExternalSessionsInvocation;
  const list = (query?: string, cursor?: string, scanDeadlineAtMs?: number) => contribution.listCandidates({ ...invocation, source,
    maxItems: 1, searchTarget: query === undefined ? 'metadata' : 'content', searchTerm: query, cursor, scanDeadlineAtMs });
  const page = (cursor?: string, maxItems = 2) => contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'fixture-session', direction: 'older', maxItems, cursor });
  return { home, file, project, contribution, source, invocation, list, page };
}

describe('CodeBuddy native conversation reader', () => {

  it.each(['page', 'follow'] as const)('preserves an actionable record-limit failure for %s reads', async operation => {
    const t = await setup();
    const initial = await t.page(undefined, 10);
    if (!initial.ok || !initial.value.tailCursor) throw new Error(JSON.stringify(initial));
    t.invocation.maxSerializedBytes = 4096;
    await appendFile(t.file, JSON.stringify({ type: 'message', id: 'oversized', parentId: 'result1', role: 'assistant', content: 'after', padding: 'x'.repeat(8192) }) + '\n');
    const result = operation === 'page' ? await t.page(undefined, 10)
      : await t.contribution.readAfterTranscript({ ...t.invocation, source: t.source, remoteSessionId: 'fixture-session', maxItems: 10, cursor: initial.value.tailCursor });
    expect(result).toMatchObject({ ok: false, code: 'agent_error', retryable: false, message: expect.stringContaining('JSONL') });
  });
  it('matches decoded real-producer bodies with stable locators and excludes tool metadata', async () => {
    const t = await setup();
    for (const query of ['harbor question', 'café 東京', 'C:\\garden\\note.txt', '"quoted phrase"', 'riverglass']) {
      const result = await t.list(query);
      expect(result).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: 'fixture-session', match: { snippet: expect.stringContaining(query) } }] } });
    }
    expect(await t.list('tool-metadata-only')).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
    const page = await t.page(undefined, 10);
    expect(page).toMatchObject({ ok: true, value: { items: [{ id: 'u1', messageRole: 'user' }, { id: 'a1' }, { id: 'result1' }], nextCursor: null } });
    if (page.ok) for (const item of page.value.items) expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
  });

  it('retains text beyond previews and marks unknown records/version as partial without disclosing payload', async () => {
    const t = await setup();
    await appendFile(t.file, `${JSON.stringify({ id: 'long', parentId: 'result1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${'x'.repeat(25_000)} long-body-needle` }], timestamp: 1788851510000 })}\n`);
    expect(await t.list('long-body-needle')).toMatchObject({ ok: true, value: { candidates: [{ match: { sourceItemId: 'long' } }] } });
    await appendFile(t.file, `${JSON.stringify({ id: 'unknown', type: 'future-message', version: 999, content: 'must-not-disclose' })}\n`);
    const result = await t.list('not present');
    expect(result).toMatchObject({ ok: true, value: { contentCoverage: 'partial' } });
    expect(JSON.stringify(result)).not.toContain('must-not-disclose');
    const page = await t.page(undefined, 20);
    expect(JSON.stringify(page)).toContain('unsupported content block');
    expect(JSON.stringify(page)).not.toContain('must-not-disclose');
  });

  it('yields a source-bound advancing content cursor under the caller deadline', async () => {
    const t = await setup();
    t.invocation.maxSerializedBytes = 4096;
    await appendFile(t.file, Array.from({ length: 120 }, (_, index) => `${JSON.stringify({ id: `history-${index}`, type: 'message', role: 'assistant', content: `another readable row ${'z'.repeat(150)}`, timestamp: 1788851510000 + index })}\n`).join(''));
    let clock = 100;
    vi.spyOn(Date, 'now').mockImplementation(() => clock++);
    const first = await t.list('harbor', undefined, 105);
    expect(first).toMatchObject({ ok: true, value: { contentCoverage: 'partial', nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) throw new Error('Missing continuation');
    const next = await t.list('harbor', first.value.nextCursor);
    expect(next).toMatchObject({ ok: true, value: { candidates: [{ match: { sourceItemId: 'u1' } }] } });
    expect(next.ok && next.value.nextCursor).not.toBe(first.value.nextCursor);
  });

  it.each(['append', 'smaller-budget'] as const)('resumes a large replay prepass across soft deadlines before publishing the selected branch (%s)', async kind => {
    const t = await setup();
    t.invocation.maxSerializedBytes = kind === 'smaller-budget' ? 1024 * 1024 : 64 * 1024;
    await appendFile(t.file, Array.from({ length: 20_000 }, (_, index) => JSON.stringify({
      id: `abandoned-${index}`, parentId: index ? `abandoned-${index - 1}` : 'result1',
      type: 'message', role: 'assistant', content: `abandoned needle ${'x'.repeat(200)}`,
    }) + '\n').join('') + JSON.stringify({ type: 'resend-fork-notice', parentId: 'u1' }) + '\n');
    let clock = 100;
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.spyOn(nativeFileSystem, 'open').mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === t.file) clock += 1;
      return handle;
    });
    let cursor: string | undefined;
    let pages = 0;
    do {
      const started = clock;
      const allowance = pages === 0 && kind === 'smaller-budget' ? 40 : 8;
      const result = await t.list('harbor question', cursor, started + allowance);
      expect(clock - started).toBeLessThanOrEqual(allowance);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Replay failed');
      if (result.value.nextCursor) {
        expect(result.value.contentCoverage).toBe('partial');
        expect(result.value.nextCursor).not.toBe(cursor);
        expect(result.value.candidates).toEqual([]);
      } else {
        expect(result.value.candidates).toMatchObject([{ match: { sourceItemId: 'u1' } }]);
      }
      cursor = result.value.nextCursor ?? undefined;
      pages += 1;
      if (pages === 1) {
        if (kind === 'smaller-budget') t.invocation.maxSerializedBytes = 16 * 1024;
        else await appendFile(t.file, JSON.stringify({ type: 'custom-title', title: 'updated during preparation' }) + '\n');
      }
      if (pages > 200) throw new Error('Replay did not advance to completion');
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(await t.list('abandoned needle')).toMatchObject({ ok: true, value: { candidates: [] } });
  });

  it('pages older items and reads appends, rejecting rewrites and branch rewinds', async () => {
    const t = await setup();
    const recent = await t.page();
    expect(recent).toMatchObject({ ok: true, value: { items: [{ id: 'a1' }, { id: 'result1' }], nextCursor: expect.any(String), tailCursor: expect.any(String) } });
    if (!recent.ok || !recent.value.nextCursor || !recent.value.tailCursor) throw new Error('Missing transcript cursors');
    expect(await t.page(recent.value.nextCursor)).toMatchObject({ ok: true, value: { items: [{ id: 'u1' }], nextCursor: null } });
    const appended = { id: 'a2', parentId: 'result1', type: 'message', role: 'assistant', content: 'fresh append needle', timestamp: 1788851510000 };
    await appendFile(t.file, `${JSON.stringify(appended)}\n`);
    expect(await t.page(recent.value.nextCursor)).toMatchObject({ ok: true, value: { items: [{ id: 'u1' }], nextCursor: null } });
    const after = await t.contribution.readAfterTranscript({ ...t.invocation, source: t.source, remoteSessionId: 'fixture-session', cursor: recent.value.tailCursor, maxItems: 10 });
    expect(after).toMatchObject({ ok: true, value: { outcome: 'advanced', items: [{ id: 'a2' }], hasMore: false } });
    if (!after.ok || after.value.outcome !== 'advanced') throw new Error('Append not read');
    await appendFile(t.file, `${JSON.stringify({ id: 'rewind', type: 'resend-fork-notice', parentId: 'u1', timestamp: 1788851511000, providerData: { skipRun: true, resendForkNotice: true } })}\n`);
    expect(await t.list('fresh append needle')).toMatchObject({ ok: true, value: { candidates: [] } });
    expect(await t.contribution.readAfterTranscript({ ...t.invocation, source: t.source, remoteSessionId: 'fixture-session', cursor: after.value.nextCursor, maxItems: 10 })).toMatchObject({ ok: true, value: { outcome: 'source_replaced' } });
    const bytes = await readFile(t.file, 'utf8');
    await writeFile(t.file, bytes.replace('harbor', 'meadow'));
    expect(await t.page(recent.value.nextCursor)).toMatchObject({ ok: false, code: 'source_invalid' });
  });

  it('observes native files without inventing usage and confines linked paths to the source', async () => {
    const t = await setup();
    expect(await t.contribution.resolveSource({ ...t.invocation, source: t.source })).toMatchObject({ ok: true, value: { accountingSource: { changeObservation: 'watch_file_changes', watchFileChanges: { files: expect.arrayContaining([t.file]) } } } });
    expect(await t.contribution.resolveSource({ ...t.invocation, source: t.source, includeAccountingSource: false })).toMatchObject({ ok: true, value: { source: { kind: 'codebuddyHome' } } });
    const outside = join(t.home, 'outside.jsonl'); await writeFile(outside, '{}\n');
    await symlink(outside, join(t.project, 'escape.jsonl'));
    expect(await t.contribution.resolveLinkIdentity({ ...t.invocation, source: t.source, remoteSessionId: 'escape' })).toMatchObject({ ok: false, code: 'source_invalid' });
    expect(await t.contribution.resolveLinkIdentity({ ...t.invocation, source: t.source, remoteSessionId: '../outside' })).toMatchObject({ ok: false, code: 'source_invalid' });
    expect(await t.contribution.pageTranscript({ ...t.invocation, source: { kind: 'codebuddyHome', sessionFile: outside }, remoteSessionId: 'fixture-session', direction: 'older', maxItems: 10 })).toMatchObject({ ok: false, code: 'source_invalid' });
  });

  it('drains a multi-page append even when the native file stops changing', async () => {
    const t = await setup();
    const initial = await t.page(undefined, 10);
    if (!initial.ok || !initial.value.tailCursor) throw new Error('Missing initial tail');
    await appendFile(t.file, [
      { id: 'append1', parentId: 'result1', type: 'message', role: 'assistant', content: 'first appended message', timestamp: 1788851520000 },
      { id: 'append2', parentId: 'append1', type: 'message', role: 'assistant', content: 'second appended message', timestamp: 1788851521000 },
    ].map(value => `${JSON.stringify(value)}\n`).join(''));
    const first = await t.contribution.readAfterTranscript({ ...t.invocation, source: t.source, remoteSessionId: 'fixture-session', cursor: initial.value.tailCursor, maxItems: 1 });
    expect(first).toMatchObject({ ok: true, value: { outcome: 'advanced', items: [{ id: 'append1' }], hasMore: true } });
    if (!first.ok || first.value.outcome !== 'advanced') throw new Error('Missing first append');
    const second = await t.contribution.readAfterTranscript({ ...t.invocation, source: t.source, remoteSessionId: 'fixture-session', cursor: first.value.nextCursor, maxItems: 1 });
    expect(second).toMatchObject({ ok: true, value: { outcome: 'advanced', items: [{ id: 'append2' }], hasMore: false } });
  });

  it('reads the first append after observing an empty native transcript', async () => {
    const t = await setup();
    await writeFile(t.file, '');
    const initial = await t.page(undefined, 10);
    if (!initial.ok || !initial.value.tailCursor) throw new Error('Missing empty tail');
    await appendFile(t.file, JSON.stringify({ id: 'first', type: 'message', role: 'user', content: 'first native prompt' }) + '\n');
    expect(await t.contribution.readAfterTranscript({ ...t.invocation, source: t.source, remoteSessionId: 'fixture-session',
      cursor: initial.value.tailCursor, maxItems: 10 })).toMatchObject({ ok: true,
        value: { outcome: 'advanced', items: [{ id: 'first' }], hasMore: false } });
  });

  it('keeps ordinary disconnected history unless native replay declares a rewind', async () => {
    const t = await setup();
    // Native resolveReplayHistory returns all non-fact items without a resend
    // or content-filter marker, even when compaction introduced another root.
    await appendFile(t.file, `${JSON.stringify({ id: 'new-root', type: 'message', role: 'user', content: 'A new segment after compaction', timestamp: 1788851530000 })}\n`);
    expect(await t.list('harbor question')).toMatchObject({ ok: true, value: { candidates: [{ match: { sourceItemId: 'u1' } }] } });
  });

  it('reports a torn tail as partial and distinguishes deletion from cancellation', async () => {
    const t = await setup();
    await appendFile(t.file, '{"type":"message","content":"unfinished');
    expect(await t.list('absent phrase')).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    const controller = new AbortController(); controller.abort();
    expect(await t.contribution.listCandidates({ ...t.invocation, signal: controller.signal, source: t.source, maxItems: 1 })).toMatchObject({ ok: false, code: 'cancelled' });
    await rm(t.file);
    expect(await t.list('harbor')).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'complete' } });
  });

  it('normalizes nullable and home-relative source roots through the SDK path owner', async () => {
    const t = await setup();
    const envHome = join(t.home, 'account-home'); const agentHome = join(envHome, '.codebuddy');
    await mkdir(join(agentHome, 'projects', 'fixture-workspace'), { recursive: true });
    await copyFile(t.file, join(agentHome, 'projects', 'fixture-workspace', 'fixture-session.jsonl'));
    const contribution = createCodeBuddyExternalSessionsContribution({ HOME: envHome, USERPROFILE: envHome });
    for (const homeDir of [null, '~/.codebuddy', '~\\.codebuddy']) {
      expect(await contribution.listCandidates({ ...t.invocation, source: { kind: 'codebuddyHome', homeDir }, maxItems: 1,
        searchTarget: 'content', searchTerm: 'harbor question' })).toMatchObject({ ok: true, value: { candidates: [{ remoteSessionId: 'fixture-session' }] } });
    }
  });

  it('keeps unsupported append and torn-tail loss visible to incremental consumers', async () => {
    const t = await setup(); const initial = await t.page(undefined, 20);
    if (!initial.ok || !initial.value.tailCursor) throw new Error('Missing initial tail');
    await appendFile(t.file, `${JSON.stringify({ id: 'future', type: 'future-message', version: 999, content: 'private unknown payload' })}\n`);
    const after = await t.contribution.readAfterTranscript({ ...t.invocation, source: t.source, remoteSessionId: 'fixture-session', cursor: initial.value.tailCursor, maxItems: 20 });
    expect(after).toMatchObject({ ok: true, value: { outcome: 'advanced', diagnostics: [{ severity: 'required' }] } });
    expect(JSON.stringify(after)).not.toContain('private unknown payload');
    if (!after.ok || after.value.outcome !== 'advanced') throw new Error('Missing append cursor');
    await appendFile(t.file, '{"type":"message","content":"incomplete');
    expect(await t.contribution.readAfterTranscript({ ...t.invocation, source: t.source, remoteSessionId: 'fixture-session', cursor: after.value.nextCursor, maxItems: 20 })).toMatchObject({ ok: true, value: { outcome: 'advanced', diagnostics: [{ severity: 'required' }] } });
  });

  it('projects native fractional filesystem timestamps to the host integer boundary', async () => {
    const t = await setup();
    await utimes(t.file, 1788851530.1255, 1788851530.1255);
    const result = await t.list();
    if (!result.ok || !result.value.candidates[0]) throw new Error('Missing native candidate');
    expect(Number.isSafeInteger(result.value.candidates[0].updatedAtMs)).toBe(true);
    expect(result.value.candidates[0].updatedAtMs).toBeGreaterThanOrEqual(0);
  });

  it('preserves a failed read when native storage becomes temporarily unreadable', async () => {
    const t = await setup(); const page = await t.page(undefined, 20);
    if (!page.ok || !page.value.tailCursor) throw new Error('Missing initial tail');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    // Source-directory admission succeeds; the following transcript stat fails.
    vi.mocked(nativeFileSystem.stat).mockResolvedValueOnce(await actual.stat(join(t.home, 'projects'), { bigint: true }))
      .mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
    expect(await t.contribution.readAfterTranscript({ ...t.invocation,
      source: { ...t.source, homeDir: t.home, sessionFile: t.file }, remoteSessionId: 'fixture-session', cursor: page.value.tailCursor, maxItems: 20 }))
      .toMatchObject({ ok: false, code: 'agent_error' });
  });

  it('reports confirmed file removal without treating an unavailable source root as deletion', async () => {
    const t = await setup(); const page = await t.page(undefined, 20);
    if (!page.ok || !page.value.tailCursor) throw new Error('Missing initial tail');
    const request = { ...t.invocation, source: { ...t.source, homeDir: t.home, sessionFile: t.file },
      remoteSessionId: 'fixture-session', cursor: page.value.tailCursor, maxItems: 20 };
    await rm(t.file);
    expect(await t.contribution.readAfterTranscript(request)).toMatchObject({ ok: true, value: { outcome: 'source_unavailable' } });
    await rm(join(t.home, 'projects'), { recursive: true });
    expect(await t.contribution.readAfterTranscript(request)).toMatchObject({ ok: false, code: 'unavailable' });
  });
});
