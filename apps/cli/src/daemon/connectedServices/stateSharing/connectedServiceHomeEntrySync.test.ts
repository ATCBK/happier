import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { moveConnectedServiceHomeEntryAside } from './connectedServiceHomeEntrySync';

describe('moveConnectedServiceHomeEntryAside', () => {
  it('retains a home after more than one hundred displaced names in the same clock tick', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-home-many-displacements-'));
    const now = vi.spyOn(Date, 'now').mockReturnValue(123);
    try {
      const home = join(root, 'sessions');
      await mkdir(home);
      await writeFile(join(home, 'history'), 'current-history');
      await Promise.all(Array.from({ length: 105 }, async (_, index) => {
        const occupied = `${home}.local-123${index === 0 ? '' : `-${index}`}`;
        await mkdir(occupied);
        await writeFile(join(occupied, 'history'), 'retained-history');
      }));
      await moveConnectedServiceHomeEntryAside(home);
      expect(await readFile(`${home}.local-123-105/history`, 'utf8')).toBe('current-history');
      expect(await readFile(`${home}.local-123/history`, 'utf8')).toBe('retained-history');
    } finally {
      now.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
