import { execFile } from 'node:child_process';
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
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
    const lines = ['{"text":"unrelated"}', '{"text":"needle needle"}', '{"text":"n\\u0065edle"}', '{"text":"K sign"}', '{"text":"İ"}', JSON.stringify({ text: 'line\nbreak' })];
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
    for (const [query, expected] of [['needle', [lines[1], lines[2]]], ['k sign', [lines[3]]], ['i', [lines[3], lines[4]]], ['line\nbreak', [lines[5]]]] as const) {
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

it('seeks sparse candidate rows through the same byte scanner without reading excluded gaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sparse-jsonl-'));
  try {
    const path = join(root, 'native.jsonl');
    const excluded = JSON.stringify({ text: 'ordinary '.repeat(2000) }) + '\n';
    const first = JSON.stringify({ text: 'first needle' }) + '\n';
    // A candidate near the beginning of a large row must still read its end.
    const last = JSON.stringify({ text: 'last needle ' + 'output '.repeat(20000) }) + '\n';
    const body = excluded.repeat(100) + first + excluded.repeat(100) + last + excluded.repeat(100);
    await writeFile(path, body);
    const offsets = [body.indexOf(first), body.indexOf(last)];
    let bytesRead = 0;
    const skippedRanges: number[] = [];
    const page = await readJsonlFileBackwardPage({ filePath: path, endOffsetBytes: null,
      maxBytes: Buffer.byteLength(body), maxItems: 100,
      candidateByteOffsets: offsets,
      shouldParseLine: (start, end) => offsets.some(offset => offset >= start && offset < end),
      onSkippedRange: (start, end) => { skippedRanges.push(end - start); },
      fileSystem: { stat, read: async (path, position, length) => {
        const file = await open(path, 'r');
        try {
          const buffer = Buffer.alloc(length);
          const result = await file.read(buffer, 0, length, position);
          bytesRead += result.bytesRead;
          return buffer.subarray(0, result.bytesRead);
        } finally { await file.close(); }
      } },
    });
    expect(page.items.map(line => line.value)).toEqual([JSON.parse(first), JSON.parse(last)]);
    expect(page.reachedStart).toBe(true);
    expect(bytesRead).toBeLessThan(Buffer.byteLength(body) / 2);
    expect(skippedRanges.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(Buffer.byteLength(body) / 2);
    const recent = await readJsonlFileBackwardPage({ filePath: path, endOffsetBytes: null,
      maxBytes: Buffer.byteLength(body), maxItems: 1, candidateByteOffsets: offsets });
    expect(recent.items.map(line => line.value)).toEqual([JSON.parse(last)]);
    expect(recent.reachedStart).toBe(false);
    const older = await readJsonlFileBackwardPage({ filePath: path, endOffsetBytes: recent.nextEndOffsetBytes,
      maxBytes: Buffer.byteLength(body), maxItems: 1, candidateByteOffsets: offsets });
    expect(older.items.map(line => line.value)).toEqual([JSON.parse(first)]);
    expect(older.reachedStart).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves admitted sparse damage and an unfinished tail without diagnosing excluded bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sparse-damage-'));
  try {
    const path = join(root, 'native.jsonl');
    const gap = Buffer.from((JSON.stringify({ text: 'ordinary '.repeat(2000) }) + '\n').repeat(100));
    const damaged = Buffer.concat([Buffer.from('needle'), Buffer.from([0xff, 0x0a])]);
    const malformed = Buffer.from('{"text":needle}\n');
    const good = Buffer.from('{"text":"needle"}\n');
    const tail = Buffer.from('{"text":"needle');
    const body = Buffer.concat([gap, damaged, malformed, good, gap, Buffer.from([0xff, 0x0a]), tail]);
    await writeFile(path, body);
    const start = gap.length;
    const offsets = [start, start + damaged.length, start + damaged.length + malformed.length, body.length - tail.length];
    const page = await readJsonlFileBackwardPage({ filePath: path, endOffsetBytes: null,
      maxBytes: body.length, maxItems: 100, candidateByteOffsets: offsets, includeMalformedRecords: true });
    expect(page.items.map(line => line.value)).toEqual([null, { text: 'needle' }]);
    expect(page.diagnostics).toEqual([{ code: 'malformed_source_utf8', count: 1, positions: [start + 6] }]);
    expect(page.tailOffsetBytes).toBe(body.length - tail.length);
    expect(page.reachedStart).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
