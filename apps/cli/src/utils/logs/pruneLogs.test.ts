import { mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { pruneLogs } from './pruneLogs';

describe('pruneLogs', () => {
  it('keeps the newest matching logs and always keeps the current path', async () => {
    const dir = createTempDirSync('happier-prune-logs-');
    try {
      await mkdir(dir, { recursive: true });
      for (const name of [
        '2026-06-30-10-00-00-pid-1.log',
        '2026-06-30-10-01-00-pid-2.log',
        '2026-06-30-10-02-00-pid-3.log',
      ]) {
        await writeFile(join(dir, name), `${name}\n`, 'utf8');
      }

      const currentPath = join(dir, '2026-06-30-10-00-00-pid-1.log');
      await expect(pruneLogs({ dir, suffix: '.log', keepCount: 1, keepPath: currentPath })).resolves.toMatchObject({ pruned: 1 });

      await expect(readdir(dir)).resolves.toEqual([
        '2026-06-30-10-00-00-pid-1.log',
        '2026-06-30-10-02-00-pid-3.log',
      ]);
    } finally {
      removeTempDirSync(dir);
    }
  });

  it('prunes aged files without a count cap, keeps exemptions and never follows a symlink', async () => {
    const dir = createTempDirSync('happier-prune-age-');
    try {
      for (const name of ['old.log', 'current.log', 'crashed.log', 'young.log', 'outside']) {
        await writeFile(join(dir, name), name);
        await utimes(join(dir, name), 1, name === 'young.log' ? 10 : 1);
      }
      await symlink(join(dir, 'outside'), join(dir, 'link.log'));
      const result = await pruneLogs({ dir, suffix: '.log', olderThanMs: 5_000, keepPaths: [join(dir, 'current.log'), join(dir, 'crashed.log')] });
      expect(result.pruned).toBe(1);
      expect(await readdir(dir)).toEqual(['crashed.log', 'current.log', 'link.log', 'outside', 'young.log']);
    } finally { removeTempDirSync(dir); }
  });

  it('excludes daemon logs from session log pruning', async () => {
    const dir = createTempDirSync('happier-prune-logs-');
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '2026-06-30-10-00-00-pid-1.log'), 'session\n', 'utf8');
      await writeFile(join(dir, '2026-06-30-09-00-00-pid-99-daemon.log'), 'daemon\n', 'utf8');

      await expect(pruneLogs({ dir, suffix: '.log', excludeSuffix: '-daemon.log', keepCount: 0 })).resolves.toMatchObject({ pruned: 1 });

      await expect(readdir(dir)).resolves.toEqual(['2026-06-30-09-00-00-pid-99-daemon.log']);
    } finally {
      removeTempDirSync(dir);
    }
  });
});
