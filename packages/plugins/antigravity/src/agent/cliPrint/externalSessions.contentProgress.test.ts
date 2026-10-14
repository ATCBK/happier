import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Shared Protocol import-cycle mitigation: preload the real Workflow owner.
// Its owner is correcting initialization order; no schema is mocked here.
import '@happier-dev/protocol/workflows/workflowV1';
import { createAntigravityExternalSessionsContribution } from './externalSessions.js';

// Preserve real filesystem data/handles; only charge native reads to the clock.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(fileSystem.open).mockReset().mockImplementation(actual.open);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function corpus() {
  const home = await mkdtemp(join(tmpdir(), 'fsp-r60-antigravity-'));
  roots.push(home);
  const brainDir = join(home, '.gemini', 'antigravity-cli', 'brain');
  const fixture = await readFile(new URL('./transcript/__fixtures__/transcript_full.semantic.sanitized.jsonl', import.meta.url), 'utf8');
  const records = fixture.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.type !== 'FUTURE_OBSERVATION');
  // Preserve the native planner/tool-result correlation from the sanitized
  // source fixture. One oversized planner row must commit before yielding.
  records[1] = { ...records[1], text: 'ordinary '.repeat(70_000) };
  records.push(...Array.from({ length: 12 }, (_, index) => ({
    step_index: 20 + index, type: 'PLANNER_RESPONSE', text: `ordinary row ${index}`,
  })), { step_index: 40, type: 'PLANNER_RESPONSE', text: 'Body-only café needle' });
  const paths: string[] = [];
  for (const [id, rows] of [['conversation-first', records], ['conversation-later', [{ id: 'later', type: 'PLANNER_RESPONSE', text: 'Body-only café needle later' }]]] as const) {
    const directory = join(brainDir, id, '.system_generated', 'logs');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'transcript_full.jsonl');
    await writeFile(path, rows.map((record) => JSON.stringify(record)).join('\n') + '\n');
    paths.push(path);
  }
  const contribution = createAntigravityExternalSessionsContribution({ env: { HOME: home } });
  const request = {
    source: { kind: 'antigravityCliPrint' }, maxItems: 1, maxSerializedBytes: 1024 * 1024,
    searchTarget: 'content' as const, searchTerm: 'Body-only café needle',
    signal: new AbortController().signal,
    // Process boundary only. Non-ASCII requires decoded matching regardless.
    ripgrep: { run: async () => ({ exitCode: 0, stdout: 'hit\0', stderr: '' }) },
  };
  return { contribution, request, paths };
}

describe('Antigravity native content continuation', () => {
  it('commits indivisible native rows across identical budgets, rematches native text and advances beyond the file', async () => {
    const { ExternalSessionCandidateV1Schema, ExternalSessionCandidateMatchV1Schema } = await import('@happier-dev/protocol/sessions/external/daemonRpcV1');
    const { contribution, request, paths } = await corpus();
    const transcript = await contribution.pageTranscript({ ...request, maxItems: 100, remoteSessionId: 'conversation-first', direction: 'older' });
    if (!transcript.ok) throw new Error(JSON.stringify(transcript));
    const expectedIndex = transcript.value.items.findIndex((item) => {
      const content = item.raw.content;
      if (!content || typeof content !== 'object' || Array.isArray(content) || content.type !== 'acp') return false;
      const data = content.data;
      return data !== null && typeof data === 'object' && !Array.isArray(data)
        && data.type === 'message' && data.message === request.searchTerm;
    });
    expect(expectedIndex).toBeGreaterThan(10);
    const expectedId = transcript.value.items[expectedIndex]!.id;
    let nowMs = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      nowMs += 3000;
      return handle;
    });
    const hits = [];
    let cursor: string | null = null;
    let firstCursor: string | undefined;
    let pendingCallsSeen = false;
    for (let page = 0; page < 30; page += 1) {
      const result = await contribution.listCandidates({ ...request, scanDeadlineAtMs: nowMs + 15_000,
        ...(cursor ? { cursor } : {}) });
      if (!result.ok) throw new Error(JSON.stringify(result));
      for (const candidate of result.value.candidates) {
        hits.push(ExternalSessionCandidateV1Schema.parse(candidate));
        ExternalSessionCandidateMatchV1Schema.parse(candidate.match);
      }
      if (!result.value.nextCursor) { cursor = null; expect(result.value.contentCoverage).toBe('complete'); break; }
      expect(result.value.contentCoverage).toBe('partial');
      if (cursor) expect(result.value.nextCursor).not.toBe(cursor);
      firstCursor ??= result.value.nextCursor;
      const continuation = JSON.parse(Buffer.from(result.value.nextCursor, 'base64url').toString('utf8')) as { contentProgress?: { pendingToolCallIds: string[] } };
      pendingCallsSeen ||= (continuation.contentProgress?.pendingToolCallIds.length ?? 0) === 2;
      cursor = result.value.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(hits.map((hit) => hit.remoteSessionId).sort()).toEqual(['conversation-first', 'conversation-later']);
    expect(hits.find((hit) => hit.remoteSessionId === 'conversation-first')?.match).toEqual({
      sourceItemId: expectedId, messageIndex: expectedIndex, snippet: request.searchTerm,
    });
    expect(firstCursor).toBeDefined();
    expect(pendingCallsSeen).toBe(true);
    const edited = JSON.parse(Buffer.from(firstCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const progress = edited.contentProgress as Record<string, unknown>;
    progress.offsetBytes = (await actual.stat(paths[0]!)).size;
    progress.match = { startOffsetBytes: 0, endOffsetBytes: Buffer.byteLength((await readFile(paths[0]!, 'utf8')).split('\n')[0]!), itemIndex: 0, messageIndex: 0 };
    const rematched = await contribution.listCandidates({ ...request, scanDeadlineAtMs: nowMs + 15_000,
      cursor: Buffer.from(JSON.stringify(edited), 'utf8').toString('base64url') });
    if (!rematched.ok) throw new Error(JSON.stringify(rematched));
    expect(rematched.value.candidates.some((hit) => hit.remoteSessionId === 'conversation-first')).toBe(false);
    await appendFile(paths[0]!, '{"type":"CHECKPOINT"}\n');
    await expect(contribution.listCandidates({ ...request, scanDeadlineAtMs: nowMs + 15_000,
      cursor: firstCursor })).resolves.toMatchObject({ ok: false, code: 'source_invalid' });
  });

  it('honours native read cancellation and never publishes a partial hit after the hard lifetime ends', async () => {
    const { contribution, request } = await corpus();
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let opens = 0;
    vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (++opens > 1) controller.abort();
      return handle;
    });
    await expect(contribution.listCandidates({ ...request, signal: controller.signal })).resolves.toMatchObject({ ok: false, code: 'cancelled' });
  });
});
