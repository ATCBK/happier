import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE, withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import {
  resolveCliSharedDepsBuildLockPath,
  withOptionalCliSharedDepsBuildLock,
} from './optionalWorkspaceBundleLock.mjs';

describe('optionalWorkspaceBundleLock', () => {
  it('uses the canonical CLI shared-dependency publication lock path', () => {
    const repoRoot = join(tmpdir(), 'happier-lock-path');

    expect(resolveCliSharedDepsBuildLockPath(repoRoot)).toBe(
      join(repoRoot, '.project', 'tmp', 'cli-shared-deps.lock'),
    );
  });

  it('reenters only when the inherited owner lease exactly matches', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-lock-reentry-'));
    try {
      const lockPath = resolveCliSharedDepsBuildLockPath(repoRoot);

      const result = await withWorkspaceBundleLock(
        async ({ heldLockValue }) =>
          await withOptionalCliSharedDepsBuildLock(
            async () => 'nested',
            {
              repoRoot,
              lockPath,
              env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue },
              lockTimeoutMs: 60,
              lockPollIntervalMs: 10,
              lockStaleAfterMs: 1_000,
            },
          ),
        {
          lockPath,
          timeoutMs: 2_000,
          pollIntervalMs: 10,
          staleAfterMs: 1_000,
        },
      );

      expect(result).toBe('nested');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('does not reenter when the inherited lock path does not match', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'happier-cli-lock-mismatch-'));
    try {
      const lockPath = resolveCliSharedDepsBuildLockPath(repoRoot);
      const waits: string[] = [];
      let entered = () => {};
      const acquired = new Promise<void>((resolve) => { entered = resolve; });
      const holder = withWorkspaceBundleLock(async () => {
        entered();
        // Release a healthy incumbent; its wait budget is owned by the lock.
        await delay(100);
      }, { lockPath });
      await acquired;
      try {
        const successor = withOptionalCliSharedDepsBuildLock(async () => 'successor', {
          repoRoot,
          lockPath,
          env: { HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: join(repoRoot, 'different.lock') },
          lockPollIntervalMs: 10,
          lockStaleAfterMs: 1_000,
          onWait: (event: { lockPath: string }) => waits.push(event.lockPath),
        });
        if (process.env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED === '0') {
          await expect(successor).rejects.toMatchObject({ code: WORKSPACE_BUNDLE_LOCK_BUSY_ERROR_CODE });
        } else {
          expect(await successor).toBe('successor');
          expect(waits).toContain(lockPath);
        }
      } finally { await holder; }
      await expect(withOptionalCliSharedDepsBuildLock(async () => 'successor', { repoRoot, lockPath }))
        .resolves.toBe('successor');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
