import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ reads: 0, bytes: 0, opens: 0, parses: 0, parseMs: 0,
    files: new Map<string, { reads: number; bytes: number }>() }));
vi.mock('node:fs/promises', async (original) => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        probe.opens += 1;
        const handle = await actual.open(...args);
        return new Proxy(handle, { get(target, property) {
            if (property === 'read') return async (...input: Parameters<typeof target.read>) => {
                const result = await Reflect.apply(target.read, target, input);
                probe.reads += 1; probe.bytes += result.bytesRead;
                const key = String(args[0]);
                const file = probe.files.get(key) ?? { reads: 0, bytes: 0 };
                file.reads += 1; file.bytes += result.bytesRead;
                probe.files.set(key, file);
                return result;
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    } };
});

import { listClaudeExternalSessionCandidates } from '../../../../../packages/plugins/claude/src/agent/surfaces/sessions/external/candidates';
import { run } from '@/integrations/ripgrep';
import { createExternalSessionContentSearchControl, searchExternalSessionContent } from '@happier-dev/plugin-sdk/sessions/file-stores';
import type { AgentExternalSessionsRipgrep } from '@happier-dev/plugin-sdk/sessions/external';

const ripgrep: AgentExternalSessionsRipgrep = { run: request =>
    run([...request.args, ...request.paths], { signal: request.signal }) };

describe('native search scan work', () => {
    it('measures a tool-heavy native page without changing its explicit paging contract', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-native-scan-'));
        try {
            const project = join(root, 'projects', '-repo');
            await mkdir(project, { recursive: true });
            // Native Claude user/assistant chain with large tool-result rows.
            const rows = Array.from({ length: 2000 }, (_, index) => ({ type: index % 2 ? 'assistant' : 'user',
                uuid: `row-${index}`, parentUuid: index ? `row-${index - 1}` : null,
                message: { role: index % 2 ? 'assistant' : 'user', content: index % 2
                    ? [{ type: 'text', text: 'ordinary assistant response' }]
                    : [{ type: 'tool_result', tool_use_id: `tool-${index}`, content: 'large \\tool payload '.repeat(1000) }] },
            }));
            rows[0] = { type: 'user', uuid: 'row-0', parentUuid: null,
                message: { role: 'user', content: [{ type: 'text', text: 'silver meadow in a native conversation' }] } };
            const miss = rows.slice(1).map(row => JSON.stringify(row)).join('\n') + '\n';
            for (let index = 0; index < 4; index += 1) await writeFile(join(project, `miss-${index}.jsonl`), miss);
            await writeFile(join(project, 'session.jsonl'), JSON.stringify(rows[0]) + '\n');
            Object.assign(probe, { reads: 0, bytes: 0, opens: 0, parses: 0, parseMs: 0 });
            probe.files.clear();
            const parse = JSON.parse;
            const spy = vi.spyOn(JSON, 'parse').mockImplementation((...args: Parameters<typeof JSON.parse>) => {
                const start = performance.now();
                try { return parse(...args); } finally { probe.parses += 1; probe.parseMs += performance.now() - start; }
            });
            const start = performance.now();
            let page;
            try {
                page = await listClaudeExternalSessionCandidates({ source: { kind: 'claudeConfig', configDir: root }, env: {},
                    searchTarget: 'content', searchTerm: 'silver meadow', limit: 5, ripgrep,
                });
            } finally { spy.mockRestore(); }
            console.info('R84_SCAN_PROFILE', JSON.stringify({ elapsedMs: performance.now() - start, ...probe,
                files: [...probe.files].map(([path, value]) => ({ file: basename(path), ...value })),
                hits: page.candidates.length, hasMore: Boolean(page.nextCursor) }));
            expect(page.candidates).toMatchObject([{ remoteSessionId: 'session', match: { messageIndex: 0 } }]);
            expect(page.nextCursor).toBeNull();
            // Proving a miss with rg must avoid decoding the large unrelated
            // tool payloads. This measures work, not a machine-speed deadline.
            expect(probe.bytes).toBeLessThan(Buffer.byteLength(miss));
        } finally { await rm(root, { recursive: true, force: true }); }
    });

    it.each([
        ['plain needle', 'plain needle'],
        ['escaped newline\nand "quotes"', 'escaped newline\nand "quotes"'],
        ['path C:\\work/a/b', 'path C:\\work/a/b'],
        ['needle', '\\u006eeedle'],
        ['a/b', 'a\\/b'],
    ])('retains real JSON producer escaping for %j', async (query, text) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-prefilter-'));
        try {
            const filePath = join(root, 'native.jsonl');
            const escaped = text.startsWith('\\u') || text.includes('\\/')
                ? `{"body":"${text}"}\n` : JSON.stringify({ body: text }) + '\n';
            await writeFile(filePath, escaped);
            const result = await searchExternalSessionContent({ query, paths: [filePath], ripgrep,
                control: createExternalSessionContentSearchControl({}),
                decode: async matchText => ({ records: [{ id: 'native-body',
                    snippet: matchText((JSON.parse(escaped) as { body: string }).body) ?? undefined }], partial: false }),
            });
            expect(result.match?.sourceItemId).toBe('native-body');
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
