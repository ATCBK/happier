import { describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { handleAuthCliCommand } from './auth';

describe('auth argument error secret custody', () => {
  const secret = 'credential-entered-in-the-wrong-argument';
  it.each([
    [secret],
    ['login', '--method', secret],
    ['login', `--method=${secret}`],
    ['pair-remote', '--ssh', 'user@host', secret],
    ['enroll-remote', '--json-lines', '--home-target-stdin', secret],
  ].map(args => ({ args })))('does not echo rejected arguments for $args', async ({ args }) => {
    // Load the real command graph before interception so import failures cannot
    // masquerade as an argument rejection.
    if (args[0] === 'login') await import('./auth/login');
    if (args[0] === 'pair-remote') await import('./auth/pairRemote');
    if (args[0] === 'enroll-remote') await import('./auth/enrollRemote');
    await withTempDir('happier-auth-secret-args-', async home => {
      const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('test_exit'); });
      try {
        env.patch({ HAPPIER_HOME_DIR: home });
        reloadConfiguration();
        await expect(handleAuthCliCommand({ args: ['auth', ...args], rawArgv: [], terminalRuntime: null }))
          .rejects.toThrow('test_exit');
        expect(inspect([...error.mock.calls, ...log.mock.calls], { depth: null, maxStringLength: null })).not.toContain(secret);
      } finally {
        exit.mockRestore(); log.mockRestore(); error.mockRestore(); env.restore(); reloadConfiguration();
      }
    });
  });
});
