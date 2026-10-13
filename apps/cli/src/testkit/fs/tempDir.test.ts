import { access } from 'node:fs/promises';

import { afterAll, describe, expect, it } from 'vitest';
import { withTempDir } from './tempDir';

// This file's teardown runs after setup registration. It must retain access to
// the default home until its own fixture cleanup has finished.
afterAll(async () => {
  await access(process.env.HAPPIER_HOME_DIR!);
});

describe('temp dir helpers', () => {
  it('creates and cleans up temporary directories', async () => {
    let createdDir = '';
    await withTempDir('happier-cli-testkit-temp-', async (dir) => {
      createdDir = dir;
      expect(dir).toContain('happier-cli-testkit-temp-');
      return undefined;
    });

    expect(createdDir).not.toBe('');
    await expect(access(createdDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up after failure without replacing the callback error', async () => {
    let createdDir = '';
    const failure = new Error('fixture failure');
    await expect(withTempDir('happier-cli-testkit-failed-', async dir => {
      createdDir = dir;
      await access(dir);
      throw failure;
    })).rejects.toBe(failure);
    await expect(access(createdDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
