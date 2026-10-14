import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import * as fileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import { listClaudeExternalSessionCandidates } from './candidates.js';
import { pageClaudeExternalSessionTranscript } from './transcript.js';
import { createClaudeExternalSessionsContribution } from './contribution.js';
import { RawJSONLinesSchema } from '../../../transcripts/rawJsonLines.js';

// Filesystem is a genuine system boundary; retain its actual reads and handles.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, open: vi.fn(actual.open), opendir: vi.fn(actual.opendir) };
});

const roots: string[] = [];
afterEach(async () => {
    vi.restoreAllMocks();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fileSystem.open).mockReset().mockImplementation(actual.open);
    vi.mocked(fileSystem.opendir).mockReset().mockImplementation(actual.opendir);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function corpus() {
    const configDir = await mkdtemp(join(tmpdir(), 'claude-content-'));
    roots.push(configDir);
    const directory = join(configDir, 'projects', 'project');
    await mkdir(directory, { recursive: true });
    const rows = [
        { type: 'user', uuid: 'start', parentUuid: null, message: { role: 'user', content: 'Ordinary title' } },
        { type: 'assistant', uuid: 'abandoned', parentUuid: 'start', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned phrase' }] } },
        { type: 'system', subtype: 'compact_boundary', uuid: 'bridge', parentUuid: 'start' },
        { type: 'assistant', uuid: 'body', parentUuid: 'bridge', message: { role: 'assistant', content: [{ type: 'text', text: 'Body-only café\nwith "quotes"' }] } },
        { type: 'assistant', uuid: 'tool', parentUuid: 'body', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { path: 'metadata phrase' } }] } },
    ];
    await writeFile(join(directory, 'session.jsonl'), rows.map((row) => JSON.stringify(row).replace(/é/g, '\\u00e9')).join('\n') + '\n');
    // The packaged process is the boundary; the filesystem and codecs stay real.
    const ripgrep = { run: vi.fn(async ({ args, paths }: { args: readonly string[]; paths: readonly string[]; signal?: AbortSignal }) => {
        const launcher = fileURLToPath(new URL('../../../../../../../../apps/cli/scripts/ripgrep_launcher.cjs', import.meta.url));
        try {
            const result = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([...args, '--', ...paths])]);
            return { ...result, exitCode: 0 };
        } catch (error) {
            // rg's no-match exit is a successful prefilter result, not a process failure.
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 1) {
                return { exitCode: 1, stdout: '', stderr: '' };
            }
            throw error;
        }
    }) };
    return { source: { kind: 'claudeConfig' as const, configDir, projectId: 'project' }, env: {}, limit: 10, searchTarget: 'content' as const, ripgrep };
}

describe('Claude candidate conversation search', () => {
    it('commits a large native row before cooperative yield across equally slow pages', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        await writeFile(join(directory, 'session.jsonl'), JSON.stringify({ type: 'user', uuid: 'large', parentUuid: null,
            message: { role: 'user', content: 'ordinary '.repeat(70_000) + 'Large row café needle' } }) + '\n');
        const olderPath = join(directory, 'older.jsonl');
        await writeFile(olderPath, JSON.stringify({ type: 'user', uuid: 'older', parentUuid: null,
            message: { role: 'user', content: 'Large row café needle' } }) + '\n');
        await utimes(olderPath, new Date('2025-01-01'), new Date('2025-01-01'));
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const handle = await actual.open(...args);
            nowMs += 3000;
            return handle;
        });
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const request = { source: params.source, maxItems: 1, searchTarget: 'content' as const,
            searchTerm: 'Large row café needle', signal: new AbortController().signal,
            maxSerializedBytes: 1024 * 1024, ripgrep: params.ripgrep, exec: {} as ExecService };
        const hits = [];
        let cursor: string | null = null;
        for (let page = 0; page < 30; page += 1) {
            const result = await contribution.listCandidates({ ...request, scanDeadlineAtMs: nowMs + 15_000,
                ...(cursor ? { cursor } : {}) });
            if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
            hits.push(...result.value.candidates);
            if (!result.value.nextCursor) {
                expect(result.value.contentCoverage).toBe('complete');
                cursor = null;
                break;
            }
            expect(result.value.contentCoverage).toBe('partial');
            if (cursor) expect(result.value.nextCursor).not.toBe(cursor);
            cursor = result.value.nextCursor;
        }
        expect(cursor).toBeNull();
        expect(hits.map(hit => hit.remoteSessionId)).toEqual(['session', 'older']);
        expect(hits[0]?.match).toMatchObject({ messageIndex: 0 });
        expect(hits[0]?.match?.snippet).toContain('Large row café needle');
    });
    it('keeps an incomplete native tail partial while returning decoded active-branch hits', async () => {
        const params = await corpus();
        await appendFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), '{"type":');
        const result = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'Body-only' });
        expect(result.candidates[0]?.match?.snippet).toContain('Body-only');
        expect(result.contentCoverage).toBe('partial');
    });
    it('reaches recent sessions across projects first and resumes deterministically at equal timestamps', async () => {
        const params = await corpus();
        const projects = join(params.source.configDir, 'projects');
        const stamp = new Date('2026-10-01T00:00:00Z');
        await utimes(join(projects, 'project', 'session.jsonl'), stamp, stamp);
        for (const [projectId, id, age] of [['a-old', 'old', 1], ['z-recent', 'a-hit', 3], ['z-recent', 'b-hit', 3]] as const) {
            await mkdir(join(projects, projectId), { recursive: true });
            const path = join(projects, projectId, `${id}.jsonl`);
            await writeFile(path, JSON.stringify({ type: 'user', uuid: id, parentUuid: null,
                message: { role: 'user', content: 'Recent search needle' } }) + '\n');
            const time = new Date(stamp.getTime() + age * 1000);
            await utimes(path, time, time);
        }
        const request = { ...params, source: { kind: 'claudeConfig' as const, configDir: params.source.configDir },
            searchTerm: 'Recent search needle', limit: 1 };
        const first = await listClaudeExternalSessionCandidates(request);
        expect(first.candidates.map(row => row.remoteSessionId)).toEqual(['a-hit']);
        // Enumeration order is an OS boundary, not a continuation identity.
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(fileSystem.opendir).mockImplementation(async (...args) => {
            const directory = await actual.opendir(...args);
            return new Proxy(directory, { get(target, property) {
                if (property === Symbol.asyncIterator) return async function* () {
                    const entries = [];
                    for await (const entry of target) entries.push(entry);
                    yield* entries.reverse();
                };
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            } });
        });
        const second = await listClaudeExternalSessionCandidates({ ...request, cursor: first.nextCursor! });
        expect(second.candidates.map(row => row.remoteSessionId)).toEqual(['b-hit']);
        // A newer unrelated conversation must not shift a recency continuation.
        await mkdir(join(projects, '0-new'), { recursive: true });
        await writeFile(join(projects, '0-new', 'new.jsonl'), '{}\n');
        const newer = new Date(stamp.getTime() + 10_000);
        await utimes(join(projects, 'z-recent', 'b-hit.jsonl'), newer, newer);
        const third = await listClaudeExternalSessionCandidates({ ...request, cursor: second.nextCursor! });
        expect(third.candidates.map(row => row.remoteSessionId)).toEqual(['old']);
        const final = third.nextCursor ? await listClaudeExternalSessionCandidates({ ...request, cursor: third.nextCursor }) : third;
        expect(final.nextCursor).toBeNull();
        expect(final.contentCoverage).toBe('complete');
    });
    it('budgets returned content hits rather than unrelated source files', async () => {
        const params = await corpus();
        await utimes(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), new Date('2025-01-01'), new Date('2025-01-01'));
        for (const projectId of ['a-miss', 'b-miss']) {
            await mkdir(join(params.source.configDir, 'projects', projectId));
            await writeFile(join(params.source.configDir, 'projects', projectId, 'unrelated.jsonl'), JSON.stringify({
                type: 'user', uuid: 'unrelated', parentUuid: null,
                message: { role: 'user', content: 'Ordinary body' },
            }) + '\n');
            await utimes(join(params.source.configDir, 'projects', projectId, 'unrelated.jsonl'), new Date('2026-01-01'), new Date('2026-01-01'));
        }
        const request = { ...params, source: { kind: 'claudeConfig' as const, configDir: params.source.configDir }, limit: 1 };
        const page = await listClaudeExternalSessionCandidates({ ...request, searchTerm: 'Body-only' });
        expect(page.candidates[0]?.match?.snippet).toContain('Body-only');
        expect(page.nextCursor).toBeNull();
        expect(page.contentCoverage).toBe('complete');
        const missing = await listClaudeExternalSessionCandidates({ ...request, searchTerm: 'never present' });
        expect(missing.candidates).toEqual([]);
        expect(missing.nextCursor).toBeNull();
        expect(missing.contentCoverage).toBe('complete');
    });
    it('advances through equally slow pages of the first large active branch and reaches older hits', async () => {
        const params = await corpus();
        const text = JSON.stringify({ type: 'custom-title', sessionId: 'session', customTitle: 'Obsolete native title' }) + '\n'
            + Array.from({ length: 1500 }, (_, index) => JSON.stringify({
            type: 'user', uuid: `row-${index}`, parentUuid: index === 0 ? null : `row-${index - 1}`,
            message: { role: 'user', content: index === 100 ? 'First file deadline needle earliest' : index === 1499 ? 'First file deadline needle latest' : 'ordinary '.repeat(40) },
        })).flatMap((row, index) => index === 49 ? [row, JSON.stringify({ type: 'assistant', uuid: 'abandoned', parentUuid: 'row-49',
            message: { role: 'assistant', content: [{ type: 'text', text: 'First file deadline needle abandoned' }] } })] : [row]).join('\n') + '\n'
            + JSON.stringify({ type: 'ai-title', sessionId: 'session', aiTitle: 'Latest native title' }) + '\n'
            + JSON.stringify({ type: 'custom-title', sessionId: 'session', customTitle: '' }) + '\n';
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), text);
        const olderPath = join(params.source.configDir, 'projects', 'project', 'older.jsonl');
        await writeFile(olderPath, JSON.stringify({ type: 'user', uuid: 'older', parentUuid: null,
            message: { role: 'user', content: 'First file deadline needle' } }) + '\n');
        await utimes(olderPath, new Date('2025-01-01'), new Date('2025-01-01'));
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        const sourceMtime = (await actual.stat(join(params.source.configDir, 'projects', 'project', 'session.jsonl'))).mtime;
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const handle = await actual.open(...args);
            nowMs += 3000;
            return handle;
        });
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const request = {
            source: params.source, maxItems: 1, searchTarget: 'content' as const, searchTerm: 'First file deadline needle',
            signal: new AbortController().signal, maxSerializedBytes: 1024 * 1024,
            ripgrep: params.ripgrep, exec: {} as ExecService,
        };
        const deadlineAtMs = nowMs + 15_000;
        const first = await contribution.listCandidates({ ...request, scanDeadlineAtMs: deadlineAtMs });
        expect(first).toMatchObject({ ok: true });
        if (!first.ok) throw new Error(`${first.code}: ${first.message}`);
        expect(nowMs).toBeLessThan(deadlineAtMs);
        expect(first.value).toMatchObject({ candidates: [], contentCoverage: 'partial', nextCursor: expect.any(String) });
        // A client may edit an opaque cursor. Returned content still comes
        // from a native row and must pass the canonical matcher on finalization.
        const editedCursor = JSON.parse(Buffer.from(first.value.nextCursor!, 'base64url').toString('utf8')) as unknown[];
        const progress = editedCursor[8] as Record<string, unknown>;
        const titleHeader = JSON.stringify({ type: 'custom-title', sessionId: 'session', customTitle: 'Obsolete native title' }) + '\n';
        const firstNativeRow = JSON.stringify({ type: 'user', uuid: 'row-0', parentUuid: null,
            message: { role: 'user', content: 'ordinary '.repeat(40) } });
        progress.endOffsetBytes = 0;
        progress.match = { startOffsetBytes: Buffer.byteLength(titleHeader),
            endOffsetBytes: Buffer.byteLength(titleHeader + firstNativeRow), itemIndex: 0, newerItems: 0 };
        const edited = await contribution.listCandidates({ ...request, scanDeadlineAtMs: nowMs + 15_000,
            cursor: Buffer.from(JSON.stringify(editedCursor), 'utf8').toString('base64url') });
        if (!edited.ok) throw new Error(`${edited.code}: ${edited.message}`);
        expect(edited.value.candidates.some(hit => hit.remoteSessionId === 'session')).toBe(false);
        const hits = [];
        let cursor = first.value.nextCursor;
        for (let page = 0; cursor && page < 30; page += 1) {
            const next = await contribution.listCandidates({ ...request, scanDeadlineAtMs: nowMs + 15_000, cursor });
            if (!next.ok) throw new Error(`${next.code}: ${next.message}`);
            hits.push(...next.value.candidates);
            if (next.value.nextCursor) {
                expect(next.value.contentCoverage).toBe('partial');
                expect(next.value.nextCursor).not.toBe(cursor);
            } else expect(next.value.contentCoverage).toBe('complete');
            cursor = next.value.nextCursor;
        }
        expect(cursor).toBeNull();
        expect(hits.map(hit => hit.remoteSessionId)).toEqual(['session', 'older']);
        expect(hits[0]?.match).toMatchObject({ snippet: 'First file deadline needle earliest', messageIndex: 100 });
        expect(hits[0]?.title).toBe('Latest native title');
        await appendFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), JSON.stringify({
            type: 'user', uuid: 'append', parentUuid: 'row-1499', message: { role: 'user', content: 'New native row' },
        }) + '\n');
        // Keep ordering unchanged: the full transcript identity, rather than
        // recency evidence, must reject even an edited EOF continuation.
        await utimes(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), sourceMtime, sourceMtime);
        await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: request.searchTerm,
            cursor: Buffer.from(JSON.stringify(editedCursor), 'utf8').toString('base64url'), deadlineAtMs: nowMs + 15_000 })).rejects.toMatchObject({ name: 'ClaudeCandidateSourceChangedError' });
    });
    it('resets rather than silently omitting an unvisited file updated above the consumed recency anchor', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        for (const [id, age] of [['a', 3], ['b', 2], ['c', 1]] as const) {
            const path = join(directory, `${id}.jsonl`);
            await writeFile(path, JSON.stringify({ type: 'user', uuid: id, parentUuid: null,
                message: { role: 'user', content: 'recency crossing needle' } }) + '\n');
            const time = new Date(Date.UTC(2026, 0, age));
            await utimes(path, time, time);
        }
        const request = { ...params, searchTerm: 'recency crossing needle', limit: 1 };
        const first = await listClaudeExternalSessionCandidates(request);
        expect(first.candidates.map(row => row.remoteSessionId)).toEqual(['a']);
        const newer = new Date('2026-02-01');
        await utimes(join(directory, 'b.jsonl'), newer, newer);
        await expect(listClaudeExternalSessionCandidates({ ...request, cursor: first.nextCursor! }))
            .rejects.toMatchObject({ name: 'ClaudeCandidateSourceChangedError' });
        const fresh = await listClaudeExternalSessionCandidates({ ...request, limit: 10 });
        expect(fresh.candidates.map(row => row.remoteSessionId)).toEqual(['b', 'a', 'c']);
        expect(fresh.contentCoverage).toBe('complete');
    });
    it('scans a long single-file conversation within the host budget without rereading a chunk for every row', async () => {
        const params = await corpus();
        const text = Array.from({ length: 1000 }, (_, index) => JSON.stringify({
            type: 'user', uuid: `row-${index}`, parentUuid: index === 0 ? null : `row-${index - 1}`,
            message: { role: 'user', content: index === 999 ? 'Last budget needle' : 'Ordinary body' },
        })).join('\n') + '\n';
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), text);
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const actualFileSystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        vi.mocked(fileSystem.open).mockImplementation(async (...args) => {
            const handle = await actualFileSystem.open(...args);
            // Actual OS reads are retained. Charge file-open latency to the host
            // clock, making repeated overlapping reads visible without sleeps.
            nowMs += 100;
            return handle;
        });
        const deadlineAtMs = nowMs + 15_000;
        const result = await createClaudeExternalSessionsContribution({ env: {} }).listCandidates({
            source: params.source, maxItems: 50, searchTarget: 'content', searchTerm: 'Last budget needle',
            signal: new AbortController().signal, deadlineAtMs, maxSerializedBytes: 1024 * 1024,
            ripgrep: params.ripgrep, exec: {} as ExecService,
        });
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
        expect(result.value.candidates[0]?.match).toMatchObject({ snippet: 'Last budget needle', messageIndex: 999 });
        expect(result.value.contentCoverage).toBe('complete');
        expect(nowMs).toBeLessThan(deadlineAtMs);
    });
    it('returns completed file hits and resumes before the host deadline on a large corpus', async () => {
        const params = await corpus();
        const directory = join(params.source.configDir, 'projects', 'project');
        // Four real file scans already exceed the injected 15s host budget.
        // Keep several continuation pages without making process startup the
        // test's deciding boundary on a loaded shared executor.
        const corpusSize = 4;
        const text = Array.from({ length: 400 }, (_, index) => JSON.stringify({
            type: 'user', uuid: `row-${index}`, parentUuid: index === 0 ? null : `row-${index - 1}`,
            message: { role: 'user', content: `Budget needle ${index}` },
        })).join('\n') + '\n';
        await writeFile(join(directory, 'session.jsonl'), text);
        await Promise.all(Array.from({ length: corpusSize - 1 }, (_, index) => writeFile(join(directory, `session-${index}.jsonl`), text)));
        let nowMs = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        const run = params.ripgrep.run.getMockImplementation()!;
        params.ripgrep.run.mockImplementation(async (request) => {
            const result = await run(request);
            // Clock is a genuine boundary: charge completed real-rg file work
            // against the existing host budget, without wall-clock sleeps.
            nowMs += request.paths.length * 8_000;
            return result;
        });
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const ids = new Set<string>();
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < corpusSize; pageIndex += 1) {
            const deadlineAtMs = nowMs + 15_000;
            const result = await contribution.listCandidates({
                source: params.source, maxItems: 50, searchTarget: 'content', searchTerm: 'Budget needle', cursor,
                signal: new AbortController().signal, deadlineAtMs, maxSerializedBytes: 1024 * 1024,
                ripgrep: params.ripgrep, exec: {} as ExecService,
            });
            expect(result).toMatchObject({ ok: true });
            if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
            expect(nowMs).toBeLessThan(deadlineAtMs);
            expect(result.value.candidates).toHaveLength(1);
            for (const candidate of result.value.candidates) {
                expect(candidate.match?.snippet).toContain('Budget needle');
                expect(ids.has(candidate.remoteSessionId)).toBe(false);
                ids.add(candidate.remoteSessionId);
            }
            expect(result.value.contentCoverage).toBe(pageIndex < corpusSize - 1 ? 'partial' : 'complete');
            expect(Boolean(result.value.nextCursor)).toBe(pageIndex < corpusSize - 1);
            cursor = result.value.nextCursor ?? undefined;
        }
        expect(ids.size).toBe(corpusSize);
    });
    it('finds an unescaped Unicode query whose decoded lowercase differs from ripgrep folding', async () => {
        const params = await corpus();
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), JSON.stringify({
            type: 'user', uuid: 'unicode', parentUuid: null, message: { role: 'user', content: 'İstanbul' },
        }) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'İstanbul' });
        expect(page.candidates[0]?.match).toMatchObject({ snippet: 'İstanbul', messageIndex: 0 });
        expect(page.contentCoverage).toBe('complete');
    });
    it('accepts the ASCII prefilter miss at a Unicode lowercase expansion', async () => {
        const params = await corpus();
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), JSON.stringify({
            type: 'user', uuid: 'unicode-ascii', parentUuid: null, message: { role: 'user', content: 'prefix skİ suffix' },
        }) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'ski' });
        expect(page.candidates).toEqual([]);
        expect(page.contentCoverage).toBe('complete');
    });
    it('matches decoded NUL text without passing NUL through process arguments', async () => {
        const params = await corpus();
        const query = 'body\u0000needle';
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), JSON.stringify({
            type: 'user', uuid: 'nul-body', parentUuid: null, message: { role: 'user', content: query },
        }) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: query });
        expect(page.candidates[0]?.match).toMatchObject({ snippet: query, messageIndex: 0 });
        expect(page.contentCoverage).toBe('complete');
    });
    it('keeps a large decoded body hit within the invocation payload budget', async () => {
        const params = await corpus();
        const query = '  large café\n"needle"  ';
        const text = 'distant-prefix ' + 'İ😀before '.repeat(2000) + 'first-context ' + query + ' nearby-first😀 ' + ' after😀'.repeat(2000) + ' second-context ' + query + ' distant-tail';
        const parsed = RawJSONLinesSchema.safeParse({ type: 'user', uuid: 'large-body', parentUuid: null, message: { role: 'user', content: text } });
        if (!parsed.success) throw new Error('Native Claude fixture rejected.');
        await writeFile(join(params.source.configDir, 'projects', 'project', 'session.jsonl'), JSON.stringify(parsed.data) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: query });
        const snippet = page.candidates[0]?.match?.snippet;
        expect(snippet).toContain(query);
        expect(snippet).toContain('first-context');
        expect(snippet).toContain('nearby-first😀');
        expect(snippet).not.toMatch(/distant-prefix|second-context|distant-tail/);
        expect(snippet?.length).toBeLessThan(1000);
        expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(page.candidates[0]?.match).toMatchObject({ sourceItemId: expect.stringMatching(/^claude:/), messageIndex: 0 });
        const maxSerializedBytes = 4096;
        const contribution = createClaudeExternalSessionsContribution({ env: {} });
        const invocation = {
            source: params.source, maxItems: 1, searchTarget: 'content', searchTerm: query,
            signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000, maxSerializedBytes, ripgrep: params.ripgrep,
            // Claude never invokes this process boundary in candidate listing.
            exec: {} as ExecService,
        } as const;
        const result = await contribution.listCandidates(invocation);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.code);
        expect(result.value.candidates).toHaveLength(1);
        expect(result.value.candidates[0]?.match?.snippet).toContain(query);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(maxSerializedBytes);
        expect(result.value.contentCoverage).toBe('complete');
        const packedSnippet = result.value.candidates[0]?.match?.snippet;
        if (typeof packedSnippet !== 'string') throw new Error('Expected a decoded hit.');
        const narrowerBytes = Buffer.byteLength(JSON.stringify(result)) - Buffer.byteLength(JSON.stringify(packedSnippet)) + Buffer.byteLength(JSON.stringify(query)) + 64;
        const narrower = await contribution.listCandidates({ ...invocation, maxSerializedBytes: narrowerBytes });
        if (!narrower.ok) throw new Error(`${narrower.code}: ${narrower.message}`);
        expect(narrower.value.candidates[0]?.match?.snippet).toContain(query);
        expect(narrower.value.candidates[0]?.match?.snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(Buffer.byteLength(JSON.stringify(narrower))).toBeLessThanOrEqual(narrowerBytes);
    });
    it('uses the same active ancestry for historical transcript paging', async () => {
        const params = await corpus();
        const items = [];
        let cursor: string | undefined;
        for (let index = 0; index < 10; index += 1) {
            const page = await pageClaudeExternalSessionTranscript({ ...params, providerSessionId: 'session', direction: 'older', maxBytes: 1024 * 1024, maxItems: 1, cursor });
            items.push(...page.items);
            if (!page.hasMore || !page.nextCursor) break;
            cursor = page.nextCursor;
        }
        expect(JSON.stringify(items)).not.toContain('abandoned phrase');
        expect(JSON.stringify(items)).toContain('Body-only');
        expect(JSON.stringify(items)).toContain('Ordinary title');
    });
    it('matches decoded conversation bodies and reports the codec source identity', async () => {
        const params = await corpus();
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'café\nwith "quotes"' });
        expect(page.candidates).toHaveLength(1);
        expect(page.candidates[0]?.match).toEqual({ snippet: 'Body-only café\nwith "quotes"', sourceItemId: expect.stringMatching(/^claude:/), messageIndex: 1 });
        expect(page.contentCoverage).toBe('complete');
        await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'Body-only' });
        expect(params.ripgrep.run.mock.calls.at(-1)?.[0].paths).toEqual([await realpath(join(params.source.configDir, 'projects', 'project', 'session.jsonl'))]);
    });
    it('excludes tool metadata and abandoned branches', async () => {
        const params = await corpus();
        for (const searchTerm of ['metadata phrase', 'abandoned phrase']) {
            expect((await listClaudeExternalSessionCandidates({ ...params, searchTerm })).candidates).toEqual([]);
        }
    });
    it('rejects a cursor when its query or target changes', async () => {
        const params = await corpus();
        await writeFile(join(params.source.configDir, 'projects', 'project', 'second.jsonl'), JSON.stringify({ type: 'user', uuid: 'second', parentUuid: null, message: { role: 'user', content: 'Body-only' } }) + '\n');
        const page = await listClaudeExternalSessionCandidates({ ...params, searchTerm: 'Body-only', limit: 1 });
        expect(page.nextCursor).toBeTruthy();
        for (const change of [{ searchTerm: 'other' }, { searchTarget: 'metadata' as const }]) {
            await expect(listClaudeExternalSessionCandidates({ ...params, searchTerm: 'Body-only', cursor: page.nextCursor!, ...change })).rejects.toThrow(/cursor/i);
        }
    });
    it('passes cancellation to the packaged prefilter', async () => {
        const params = await corpus();
        const controller = new AbortController();
        params.ripgrep.run.mockImplementationOnce(async ({ signal }) => {
            expect(signal).toBe(controller.signal);
            controller.abort();
            signal?.throwIfAborted();
            return { exitCode: 1, stdout: '', stderr: '' };
        });
        await expect(listClaudeExternalSessionCandidates({ ...params, signal: controller.signal, searchTerm: 'Body-only' })).rejects.toThrow();
    });
});
