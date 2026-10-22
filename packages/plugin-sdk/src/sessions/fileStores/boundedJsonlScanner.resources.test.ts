import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ opens: 0, closes: 0, reads: 0, afterRead: null as (() => void) | null }));
// Measure real descriptor lifetime at the OS boundary; parsing and paging stay real.
vi.mock('node:fs/promises', async load => {
  const actual = await load<typeof import('node:fs/promises')>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...args);
    io.opens++;
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    handle.read = (async (...readArgs: Parameters<typeof read>) => {
      io.reads++;
      const result = await read(...readArgs);
      io.afterRead?.();
      return result;
    }) as typeof handle.read;
    handle.close = async () => { io.closes++; await close(); };
    return handle;
  };
  return { ...actual, open };
});

const { readJsonlFileBackwardPage, readJsonlFileForwardLines } = await import('./boundedJsonlScanner.js');
const roots: string[] = [];
afterEach(async () => {
  io.afterRead = null;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each(['forward', 'backward'] as const)('holds one descriptor across a multi-chunk %s page and releases it', async direction => {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-descriptor-'));
  roots.push(root);
  const path = join(root, 'source.jsonl');
  const values = Array.from({ length: 400 }, (_, index) => ({ index, text: 'café 😀 '.repeat(20) }));
  const body = values.map(value => JSON.stringify(value)).join('\n') + '\n';
  await writeFile(path, body);
  io.opens = io.closes = io.reads = 0;
  const bounds = { filePath: path, maxBytes: Buffer.byteLength(body), maxItems: values.length, chunkBytes: 1024 };
  const page = direction === 'forward'
    ? await readJsonlFileForwardLines({ ...bounds, offsetBytes: 0 })
    : await readJsonlFileBackwardPage({ ...bounds, endOffsetBytes: null });
  expect(page.items.map(line => line.value)).toEqual(values);
  expect(io.reads).toBeGreaterThan(1);
  // Descriptor acquisition must scale with a source page, not its chunk count.
  expect(io.opens).toBe(1);
  expect(io.closes).toBe(1);
});

it.each(['forward', 'backward'] as const)('releases the %s descriptor on cancellation during native I/O', async direction => {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-cancel-'));
  roots.push(root);
  const path = join(root, 'source.jsonl');
  await writeFile(path, '{"text":"readable"}\n');
  io.opens = io.closes = io.reads = 0;
  const abort = new AbortController();
  const reason = new Error('cancelled during native read');
  io.afterRead = () => abort.abort(reason);
  const bounds = { filePath: path, maxBytes: 4096, maxItems: 10, signal: abort.signal };
  await expect(direction === 'forward'
    ? readJsonlFileForwardLines({ ...bounds, offsetBytes: 0 })
    : readJsonlFileBackwardPage({ ...bounds, endOffsetBytes: null })).rejects.toBe(reason);
  expect(io.opens).toBe(1);
  expect(io.closes).toBe(1);
});

it.each(['forward', 'backward'] as const)('releases the %s descriptor when the consuming decoder yields', async direction => {
  const root = await mkdtemp(join(tmpdir(), 'jsonl-yield-'));
  roots.push(root);
  const path = join(root, 'source.jsonl');
  await writeFile(path, '{"text":"readable"}\n');
  io.opens = io.closes = io.reads = 0;
  const yielded = new Error('decoder yielded');
  const bounds = { filePath: path, maxBytes: 4096, maxItems: 10, onLine: () => { throw yielded; } };
  await expect(direction === 'forward'
    ? readJsonlFileForwardLines({ ...bounds, offsetBytes: 0 })
    : readJsonlFileBackwardPage({ ...bounds, endOffsetBytes: null })).rejects.toBe(yielded);
  expect(io.opens).toBe(1);
  expect(io.closes).toBe(1);
});
