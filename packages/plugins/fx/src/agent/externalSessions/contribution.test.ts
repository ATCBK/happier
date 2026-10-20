import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';
import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFxExternalSessionsContribution } from './contribution.js';

// OS stat is the only replaced operation; reads and native replay stay real.
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, stat: vi.fn(original.stat) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'happier-fx-reader-'));
  roots.push(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  const sessionDir = join(home, '.fx', 'sessions', 'native-session');
  await mkdir(join(sessionDir, 'tool-results'), { recursive: true });
  const eventsPath = join(sessionDir, 'events.jsonl');
  const events = await readFile(new URL('./__fixtures__/fx-v0.0.14-events.jsonl', import.meta.url), 'utf8');
  await writeFile(eventsPath, events);
  await writeFile(join(sessionDir, 'session.json'), JSON.stringify({ schema_version: 4,
    id: 'native-session', origin_workspace_root: '/repo', workspace_root: '/repo',
    created_at_ms: 1792490400000, updated_at_ms: 1792490400010,
    conversation_language: 'en', provider: 'openai', model: 'fixture-model', effort: 'medium',
    fast_mode: false, title: 'ordinary title', subagent_child: false }));
  const resultPath = join(sessionDir, 'tool-results', 'result-read_file-1111111111111111-2222222222222222.txt');
  await writeFile(resultPath, 'full referenced result beyond the inline preview');
  const contribution = createFxExternalSessionsContribution();
  // The process service is a genuine boundary; a file reader must never call it.
  const exec = new Proxy({} as AgentExternalSessionsInvocation['exec'], {
    get() { throw new Error('Reading native history must not run a vendor process'); },
  });
  const invocation = {
    signal: new AbortController().signal, maxSerializedBytes: 1024 * 1024,
    exec, managedEndpointRead: async () => { throw new Error('No vendor server for a file reader'); },
    ripgrep: { run: vi.fn(async ({ paths }: { paths: readonly string[] }) => ({
      exitCode: 0, stdout: paths.join('\0') + '\0', stderr: '',
    })) },
  } satisfies AgentExternalSessionsInvocation;
  const source = { kind: 'fxHome' };
  return { contribution, invocation, source, eventsPath, events, sessionDir, resultPath };
}

describe('FX v0.0.14 native External Sessions reader', () => {
  it('finds decoded body-only text through the contribution and lands on the same transcript item', async () => {
    const { contribution, invocation, source } = await fixture();
    const listed = await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      searchTarget: 'content', searchTerm: '東京 café' });
    expect(listed).toMatchObject({ ok: true, value: { contentCoverage: 'complete',
      candidates: [{ remoteSessionId: 'native-session', match: { snippet: expect.stringContaining('東京 café') } }] } });
    if (!listed.ok) throw new Error(listed.code);
    const candidate = listed.value.candidates[0]!;
    const linked = await contribution.resolveLinkIdentity({ ...invocation, source,
      remoteSessionId: candidate.remoteSessionId, linkData: candidate.linkData });
    expect(linked).toMatchObject({ ok: true, value: { remoteSessionId: 'native-session' } });
    if (!linked.ok) throw new Error(linked.code);
    const page = await contribution.pageTranscript({ ...invocation, source: linked.value.source,
      remoteSessionId: candidate.remoteSessionId, direction: 'older', maxItems: 100 });
    if (!page.ok) throw new Error(page.code);
    expect(page.value.items[candidate.match!.messageIndex]?.id).toBe(candidate.match!.sourceItemId);
    for (const item of page.value.items) expect(AgentExternalSessionTranscriptRawRecordSchema.safeParse(item.raw).success).toBe(true);
    for (const query of ['tool-metadata-only phrase', 'model-only checkpoint summary']) {
      expect(await contribution.listCandidates({ ...invocation, source, maxItems: 10,
        searchTarget: 'content', searchTerm: query })).toMatchObject({ ok: true,
        value: { candidates: [], contentCoverage: 'complete' } });
    }
  });

  it('replays checkpoint history, steering and full referenced results, excluding an unfinished tail', async () => {
    const { contribution, invocation, source, eventsPath, events } = await fixture();
    await appendFile(eventsPath, '\n' + JSON.stringify({ schema_version: 3, seq: 12, timestamp_ms: 1792490400011,
      event: { user: { text: 'uncommitted abandoned text', images: [] } } }) + '\n');
    const page = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session',
      direction: 'older', maxItems: 100 });
    if (!page.ok) throw new Error(page.code);
    const body = JSON.stringify(page.value.items.map(item => item.raw));
    expect(body).toContain('body-only phrase');
    expect(body).toContain('before steering');
    expect(body).toContain('steering request');
    expect(body).toContain('full referenced result beyond the inline preview');
    expect(body).toContain('tool-metadata-only phrase');
    expect(body).not.toContain('model-only checkpoint summary');
    expect(body).not.toContain('uncommitted abandoned text');
    await writeFile(eventsPath, events.replace('"completeness":"complete"', '"completeness":"partial"'));
    expect(await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      searchTarget: 'content', searchTerm: 'full referenced result' })).toMatchObject({ ok: true,
      value: { contentCoverage: 'partial', candidates: [{ remoteSessionId: 'native-session' }] } });
  });

  it('uses source observation for body and result changes and detects rewrite before read-after append', async () => {
    const { contribution, invocation, source, eventsPath, events, resultPath } = await fixture();
    const resolved = await contribution.resolveSource({ ...invocation, source });
    if (!resolved.ok) throw new Error(resolved.code);
    expect(resolved.value.accountingSource).toMatchObject({ changeObservation: 'watch_file_changes',
      watchFileChanges: { files: expect.arrayContaining([eventsPath, resultPath]) } });
    expect(await contribution.resolveSource({ ...invocation, source, includeAccountingSource: false }))
      .not.toHaveProperty('value.accountingSource');
    const page = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session',
      direction: 'older', maxItems: 100 });
    if (!page.ok || !page.value.tailCursor) throw new Error('Native transcript must publish its tail frontier');
    const cursor = page.value.tailCursor;
    await appendFile(eventsPath, [
      { schema_version: 3, seq: 12, timestamp_ms: 1792490400011, event: { user: { text: 'garnet appended message', images: [] } } },
      { schema_version: 3, seq: 13, timestamp_ms: 1792490400012, event: { assistant: { text: 'appended reply' } } },
      { schema_version: 3, seq: 14, timestamp_ms: 1792490400013, event: { turn_completed: { files: [], turn_summary: null } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const after = await contribution.readAfterTranscript({ ...invocation, source, remoteSessionId: 'native-session', cursor, maxItems: 100 });
    expect(after).toMatchObject({ ok: true, value: { outcome: 'advanced' } });
    if (!after.ok || after.value.outcome !== 'advanced') throw new Error('Expected appended native transcript');
    expect(JSON.stringify(after.value.items)).toContain('garnet appended message');
    expect(JSON.stringify(after.value.items)).not.toContain('body-only phrase');
    await writeFile(eventsPath, events.replace('body-only phrase', 'replacement text'));
    expect(await contribution.readAfterTranscript({ ...invocation, source, remoteSessionId: 'native-session',
      cursor: after.value.nextCursor, maxItems: 100 })).toMatchObject({ ok: true,
      value: { outcome: expect.stringMatching(/^(source_replaced|gap_or_cursor_expired)$/) } });
  });

  it('keeps unknown event versions incomplete and source deletion unavailable', async () => {
    const { contribution, invocation, source, eventsPath } = await fixture();
    const before = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    if (!before.ok || !before.value.tailCursor) throw new Error('Expected native frontier');
    await appendFile(eventsPath, JSON.stringify({ schema_version: 999, seq: 12, timestamp_ms: 1792490400011,
      event: { assistant: { text: 'unknown-version-secret' } } }) + '\n');
    const searched = await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      searchTarget: 'content', searchTerm: 'unknown-version-secret' });
    expect(searched).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    const page = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    if (!page.ok) throw new Error(page.code);
    expect(JSON.stringify(page)).not.toContain('unknown-version-secret');
    expect(JSON.stringify(page)).toContain('unsupported content block');
    expect(await contribution.readAfterTranscript({ ...invocation, source, remoteSessionId: 'native-session',
      cursor: before.value.tailCursor, maxItems: 100 })).toMatchObject({ ok: true, value: { outcome: 'read_failed' } });
    await rm(eventsPath);
    expect(await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 }))
      .toMatchObject({ ok: false, code: expect.stringMatching(/^(candidate_not_found|source_unreachable|unavailable)$/) });
  });

  it('reads a captured prefix during a native append and consumes the new turn on the next read', async () => {
    const { contribution, invocation, source, eventsPath } = await fixture();
    const { stat: actualStat } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let eventStats = 0;
    const appended = [
      { schema_version: 3, seq: 12, timestamp_ms: 1792490400011, event: { user: { text: 'concurrent append body', images: [] } } },
      { schema_version: 3, seq: 13, timestamp_ms: 1792490400012, event: { turn_completed: { files: [], turn_summary: null } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n';
    // Real filesystem boundary: the writer appends after the reader's first
    // stat, before either the scanner's stat or the reader's final stat.
    const observer = vi.spyOn(fs, 'stat').mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (args[0] === eventsPath && ++eventStats === 2) await appendFile(eventsPath, appended);
      return actualStat(...args);
    });
    const page = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    observer.mockRestore();
    expect(page).toMatchObject({ ok: true, value: { truncated: false } });
    if (!page.ok || !page.value.tailCursor) throw new Error('Expected captured native frontier');
    expect(JSON.stringify(page.value.items)).not.toContain('concurrent append body');
    expect(await contribution.readAfterTranscript({ ...invocation, source, remoteSessionId: 'native-session',
      cursor: page.value.tailCursor, maxItems: 100 })).toMatchObject({ ok: true, value: { outcome: 'advanced', items: [expect.objectContaining({ id: 'fx:12' })] } });
  });

  it('advances content continuations under the caller scan deadline and binds them to the query', async () => {
    const { contribution, invocation, source, sessionDir } = await fixture();
    const second = join(sessionDir, '..', 'second-session');
    await cp(sessionDir, second, { recursive: true });
    const metadata = JSON.parse(await readFile(join(second, 'session.json'), 'utf8'));
    await writeFile(join(second, 'session.json'), JSON.stringify({ ...metadata, id: 'second-session' }));
    const first = await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      scanDeadlineAtMs: Date.now() - 1, searchTarget: 'content', searchTerm: 'body-only phrase' });
    expect(first).toMatchObject({ ok: true, value: { contentCoverage: 'partial',
      candidates: [{ remoteSessionId: 'native-session' }], nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) throw new Error('Expected a native continuation');
    const next = await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      cursor: first.value.nextCursor, searchTarget: 'content', searchTerm: 'body-only phrase' });
    expect(next).toMatchObject({ ok: true, value: { contentCoverage: 'complete', nextCursor: null,
      candidates: [{ remoteSessionId: 'second-session' }] } });
    expect(await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      cursor: first.value.nextCursor, searchTarget: 'content', searchTerm: 'different query' }))
      .toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('pages every stable locator once and preserves long decoded bodies', async () => {
    const { contribution, invocation, source, eventsPath, events } = await fixture();
    const body = 'long prefix '.repeat(1000) + 'distant needle 東京';
    await writeFile(eventsPath, events.replace('final response', body));
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session',
        direction: 'older', maxItems: 2, ...(cursor ? { cursor } : {}) });
      if (!page.ok) throw new Error(page.code);
      ids.unshift(...page.value.items.map(item => item.id));
      cursor = page.value.nextCursor;
    } while (cursor);
    const full = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session',
      direction: 'older', maxItems: 100 });
    if (!full.ok) throw new Error(full.code);
    expect(ids).toEqual(full.value.items.map(item => item.id));
    expect(new Set(ids).size).toBe(ids.length);
    const search = await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      searchTarget: 'content', searchTerm: 'distant needle 東京' });
    expect(search).toMatchObject({ ok: true, value: { candidates: [{ match: {
      sourceItemId: full.value.items.at(-1)!.id, snippet: expect.stringContaining('distant needle 東京') } }] } });
  });

  it('retains progress inside one conversation when its next turn crosses the scan deadline', async () => {
    const { contribution, invocation, source } = await fixture();
    const first = await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      searchTerm: 'final response', searchTarget: 'content', scanDeadlineAtMs: Date.now() - 1 });
    expect(first).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial', nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) throw new Error('Expected progress inside native history');
    expect(await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      searchTerm: 'final response', searchTarget: 'content', cursor: first.value.nextCursor }))
      .toMatchObject({ ok: true, value: { contentCoverage: 'complete', nextCursor: null,
        candidates: [{ remoteSessionId: 'native-session', match: { sourceItemId: 'fx:10' } }] } });
  });

  it('replays parallel tool results beside their calls in vendor call order, not completion order', async () => {
    const { contribution, invocation, source, eventsPath } = await fixture();
    const call = (call_id: string) => ({ call_id, tool_name: 'read_file', arguments_json: '{}' });
    const result = (call_id: string) => ({ call_id, tool_name: 'read_file', status: 'success',
      artifact_ref: 'result-read_file-1111111111111111-2222222222222222.txt', stored_bytes: 48, completeness: 'complete' });
    const events = [
      { user: { text: 'parallel native step', images: [] } },
      { assistant: { text: 'parallel assistant prefix' } },
      { tool_call: call('a') }, { tool_call: call('b') },
      { tool_result: result('b') }, { tool_result: result('a') },
      { turn_completed: { files: [], turn_summary: null } },
    ];
    await appendFile(eventsPath, events.map((event, index) => JSON.stringify({ schema_version: 3,
      seq: 12 + index, timestamp_ms: 1792490400011 + index, event })).join('\n') + '\n');
    const page = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    if (!page.ok) throw new Error(page.code);
    expect(page.value.truncated).toBe(false);
    expect(page.value.items.slice(-6).map(item => item.id)).toEqual(['fx:12', 'fx:13', 'fx:14', 'fx:17', 'fx:15', 'fx:16']);
  });

  it('rejects path escapes, sidecar symlinks and cancelled invocations without a vendor process', async () => {
    const { contribution, invocation, source, resultPath } = await fixture();
    expect(await contribution.resolveLinkIdentity({ ...invocation, source, remoteSessionId: '../outside' }))
      .toMatchObject({ ok: false, code: 'invalid_request' });
    const outside = await mkdtemp(join(tmpdir(), 'happier-fx-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside-only content');
    await rm(resultPath);
    await symlink(join(outside, 'secret.txt'), resultPath);
    const search = await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      searchTarget: 'content', searchTerm: 'outside-only content' });
    expect(search).toMatchObject({ ok: true, value: { candidates: [], contentCoverage: 'partial' } });
    const controller = new AbortController();
    controller.abort();
    expect(await contribution.listCandidates({ ...invocation, signal: controller.signal, source, maxItems: 10 }))
      .toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('treats unknown fields and a torn final commit as incomplete rather than complete-empty', async () => {
    const { contribution, invocation, source, eventsPath, events } = await fixture();
    await writeFile(eventsPath, events.replace('"seq":2,', '"seq":2,"future_branch":"hidden",'));
    expect(await contribution.listCandidates({ ...invocation, source, maxItems: 10,
      searchTarget: 'content', searchTerm: 'body-only phrase' })).toMatchObject({ ok: true,
      value: { candidates: [], contentCoverage: 'partial' } });
    await writeFile(eventsPath, events.trimEnd());
    const page = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    if (!page.ok) throw new Error(page.code);
    expect(JSON.stringify(page.value.items)).not.toContain('final response');
    expect(page.value.truncated).toBe(true);
  });

  it('invalidates an old frontier for a result-only edit and never publishes interrupted recovery as a completed turn', async () => {
    const { contribution, invocation, source, eventsPath, sessionDir, resultPath } = await fixture();
    const page = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    if (!page.ok || !page.value.tailCursor) throw new Error('Expected native tail');
    await writeFile(resultPath, 'replacement sidecar output');
    expect(await contribution.readAfterTranscript({ ...invocation, source, remoteSessionId: 'native-session',
      cursor: page.value.tailCursor, maxItems: 100 })).toMatchObject({ ok: true, value: { outcome: 'gap_or_cursor_expired' } });
    await appendFile(eventsPath, [
      { schema_version: 3, seq: 12, timestamp_ms: 1792490400011, event: { user: { text: 'unfinished recovery request', images: [] } } },
      { schema_version: 3, seq: 13, timestamp_ms: 1792490400012, event: { assistant: { text: 'abandoned assistant candidate' } } },
      { schema_version: 3, seq: 14, timestamp_ms: 1792490400013, event: { tool_call: {
        call_id: 'pending', tool_name: 'read_file', arguments_json: '{}' } } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    // Supporting recovery state belongs to the vendor's writable resume path;
    // ConversationHistoryReader itself emits only settled native turns.
    await writeFile(join(sessionDir, 'recovery.json'), JSON.stringify({ user: { text: 'not a committed recovery body' } }));
    let recovered = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    expect(JSON.stringify(recovered)).not.toContain('unfinished recovery request');
    expect(JSON.stringify(recovered)).not.toContain('not a committed recovery body');
    await appendFile(eventsPath, JSON.stringify({ schema_version: 3, seq: 15, timestamp_ms: 1792490400014,
      event: { interrupted: { reason: 'cancelled', partial_text: 'interrupted visible response' } } }) + '\n');
    recovered = await contribution.pageTranscript({ ...invocation, source, remoteSessionId: 'native-session', direction: 'older', maxItems: 100 });
    expect(JSON.stringify(recovered)).toContain('unfinished recovery request');
    expect(JSON.stringify(recovered)).toContain('interrupted visible response');
    expect(JSON.stringify(recovered)).not.toContain('abandoned assistant candidate');
    expect(JSON.stringify(recovered)).not.toContain('"callId":"pending"');
  });
});
