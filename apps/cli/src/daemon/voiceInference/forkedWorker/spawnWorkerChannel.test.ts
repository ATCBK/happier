import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpawnHappyCliEnvScope, withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';
import { spawnVoiceInferenceWorkerChannel } from './spawnWorkerChannel';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
// Only the OS process adapter is replaced; CLI launch planning stays real.
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(), spawn,
}));

describe('spawnVoiceInferenceWorkerChannel', () => {
  const envScope = createSpawnHappyCliEnvScope();
  afterEach(() => {
    envScope.restore();
    spawn.mockReset();
  });

  it('contains an asynchronous EPIPE after a native worker crash and settles through termination', async () => {
    await withTempHappyCliEntrypoint(async (entrypoint) => {
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0', HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined,
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: undefined,
        HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: undefined,
        HAPPIER_MANAGED_NODE_BIN: process.execPath,
        HAPPIER_VARIANT: undefined, HAPPIER_STACK_REPO_DIR: undefined,
        HAPPIER_STACK_CLI_ROOT_DIR: undefined, HAPPIER_STACK_STACK: undefined,
      });
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdin: PassThrough;
        stdout: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.pid = 42_424;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = vi.fn(() => true);
      // Narrow fixture cast at the genuine child-process system boundary.
      spawn.mockReturnValue(child as unknown as ChildProcess);

      const channel = spawnVoiceInferenceWorkerChannel();
      const brokenPipe = Object.assign(new Error('write EPIPE'), {
        code: 'EPIPE',
        errno: -32,
        syscall: 'write',
      });

      expect(() => child.stdin.emit('error', brokenPipe)).not.toThrow();
      channel.forceTerminate();
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.emit('exit', 137, null);
      await expect(channel.waitForTermination()).resolves.toEqual({ type: 'exited', code: 137 });
    });
  });
});
