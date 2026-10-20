import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { writeFileAtomically, writeJsonAtomic } from './writeJsonAtomic';

describe('writeJsonAtomic', () => {
  it.each([0o751, 0o444])('preserves destination permissions (%o) when publishing flushed workspace content', async mode => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-preserve-mode-'));
    const path = join(dir, 'executable');
    await writeFile(path, 'before', { mode });
    await writeFileAtomically({ path, mode: 'preserve', fsync: true,
      writeTemporaryFile: temporaryPath => writeFile(temporaryPath, 'after') });
    expect(await readFile(path, 'utf8')).toBe('after');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(mode);
  });
  it('creates a new JSON file when the destination does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-new-'));
    const path = join(dir, 'state.json');

    await writeJsonAtomic(path, { generation: 1 });

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ generation: 1 });
  });

  it('writes JSON content atomically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-writeJsonAtomic-'));
    const path = join(dir, 'auth.json');

    await writeFile(path, '{"a":1}', 'utf8');
    await writeJsonAtomic(path, { a: 2, b: 'x' });

    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual({ a: 2, b: 'x' });
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });
});
