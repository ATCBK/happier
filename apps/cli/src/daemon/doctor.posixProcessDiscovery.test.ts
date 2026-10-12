import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';

describe.skipIf(process.platform !== 'linux')('doctor Linux census discovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the full root command and allowlisted scope environment from the same native facts', async () => {
    const child = spawnInlineNodeTestProcess('/* /repo/dist/index.mjs daemon start-sync */ setInterval(() => {}, 1000)', {
      env: { ...process.env, HAPPIER_HOME_DIR: '/tmp/happier doctor scoped home', HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'scope-1', PRIVATE_UNRELATED_SECRET: 'not-published' },
    });
    try {
      const { findHappyProcessByPid } = await import('./doctor');
      const result = await findHappyProcessByPid(child.pid!);
      expect(result?.type).toBe('daemon');
      expect(result?.command).toContain('/repo/dist/index.mjs daemon start-sync');
      expect(result?.daemonOwnershipEnvironmentVariables).toMatchObject({
        HAPPIER_HOME_DIR: '/tmp/happier doctor scoped home', HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: 'scope-1',
      });
      expect(result?.daemonOwnershipEnvironmentVariables).not.toHaveProperty('PRIVATE_UNRELATED_SECRET');
    } finally {
      child.kill();
      await waitForProcessExit(child.pid!);
    }
  });

  it('distinguishes a readable unrelated process from an unknown process', async () => {
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    try {
      const { classifyProcessByPid } = await import('./doctor');
      await expect(classifyProcessByPid(child.pid!)).resolves.toEqual({ kind: 'not_happy' });
    } finally {
      child.kill();
      await waitForProcessExit(child.pid!);
    }
  });
});
