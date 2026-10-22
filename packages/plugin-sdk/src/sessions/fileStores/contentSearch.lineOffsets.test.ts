import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

import { prefilterExternalSessionContentPaths } from './contentSearch.js';
import { readJsonlFileBackwardPage } from './boundedJsonlScanner.js';

it('admits candidate byte positions without returning native text, including escaped folds and path delimiters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'content-offsets-'));
  try {
    const path = join(root, process.platform === 'win32' ? 'native.jsonl' : 'native:with\nseparator.jsonl');
    const lines = ['{"text":"unrelated"}', '{"text":"needle needle"}', '{"text":"n\\u0065edle"}', '{"text":"K sign"}', '{"text":"İ"}'];
    await writeFile(path, lines.join('\n') + '\n');
    const launcher = fileURLToPath(new URL('../../../../../apps/cli/scripts/ripgrep_launcher.cjs', import.meta.url));
    const ripgrep = { run: async ({ args, paths }: { args: readonly string[]; paths: readonly string[] }) => {
      try {
        const result = await promisify(execFile)(process.execPath, [launcher, JSON.stringify([...args, '--', ...paths])]);
        expect(result.stdout).not.toContain('"text"');
        return { ...result, exitCode: 0 };
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 1) return { stdout: '', stderr: '', exitCode: 1 };
        throw error;
      }
    } };
    for (const [query, expected] of [['needle', [lines[1], lines[2]]], ['k sign', [lines[3]]], ['i', [lines[3], lines[4]]]] as const) {
      const offsets = await prefilterExternalSessionContentPaths({ query, paths: [path], ripgrep, lineOffsets: true,
        additionalLinePatterns: ['"other"\\s*:'] });
      const selected = await readJsonlFileBackwardPage({ filePath: path, endOffsetBytes: null, maxBytes: 4096, maxItems: 100,
        shouldParseLine: (start, end) => offsets === null || (offsets.get(path) ?? []).some(offset => offset >= start && offset < end) });
      // Broad escaped/folded admission can add candidates, but ordinary unrelated
      // rows must stay excluded and all real decoded hits remain reachable.
      for (const line of expected) expect(selected.items.map(item => JSON.stringify(item.value))).toContain(JSON.stringify(JSON.parse(line!)));
      expect(selected.items.some(item => JSON.stringify(item.value).includes('unrelated'))).toBe(false);
      expect(selected.reachedStart).toBe(true);
    }
    expect(await prefilterExternalSessionContentPaths({ query: 'café', paths: [path], ripgrep, lineOffsets: true })).toBeNull();
    expect(await prefilterExternalSessionContentPaths({ query: 'needle', paths: [path],
      ripgrep: { run: async () => ({ exitCode: 0, stdout: '', stderr: '', stdoutTruncated: true }) }, lineOffsets: true })).toBeNull();
    expect(await prefilterExternalSessionContentPaths({ query: 'needle', paths: [path],
      ripgrep: { run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }, lineOffsets: true })).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([false, true])('consumes skipped JSONL boundaries and diagnoses only admitted UTF-8 damage (admitted=%s)', async admittedDamage => {
  const root = await mkdtemp(join(tmpdir(), 'filtered-jsonl-'));
  try {
    const path = join(root, 'native.jsonl');
    const prefix = Buffer.from(JSON.stringify({ text: 'a'.repeat(5000) }) + '\n');
    const bad = Buffer.from([0xff, 0x0a]);
    const hit = Buffer.from('{"text":"candidate"}\r\n');
    await writeFile(path, Buffer.concat([prefix, bad, hit]));
    const skipped: number[] = [];
    const page = await readJsonlFileBackwardPage({ filePath: path, endOffsetBytes: null, maxBytes: 10000, maxItems: 100,
      chunkBytes: 1024, shouldParseLine: start => start === prefix.length + bad.length || (admittedDamage && start === prefix.length),
      onSkippedLine: start => { skipped.push(start); } });
    expect(page.items).toMatchObject([{ value: { text: 'candidate' }, startOffsetBytes: prefix.length + bad.length }]);
    expect(page.diagnostics ?? []).toEqual(admittedDamage
      ? [{ code: 'malformed_source_utf8', count: 1, positions: [prefix.length] }] : []);
    expect(skipped).toContain(0);
    expect(skipped).not.toContain(prefix.length + bad.length + hit.length);
    expect(page.nextEndOffsetBytes).toBe(0);
    expect(page.reachedStart).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
