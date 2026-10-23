import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpawnHappyCliEnvScope, withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';
import { spawnBackgroundServiceProcessChannel } from './backgroundServiceProcessChannel';

const boundary = vi.hoisted(() => ({
  spawn: vi.fn(), execFile: vi.fn(), job: '', handshakeValid: true,
}));
// OS process creation, the native helper and its marker file are the replaced
// boundaries. The CLI planner, handshake parser and lifecycle stay real.
vi.mock('child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: boundary.spawn,
}));
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(), execFileWithDeadline: boundary.execFile,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: ((path) => String(path).endsWith('happier-process-custody.exe')
    || actual.existsSync(path)) satisfies typeof actual.existsSync };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: ((...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]).includes('.happier-svc09-custody-')) {
      return Promise.resolve(JSON.stringify({ v: 1, pid: 67_890, job: boundary.handshakeValid ? boundary.job : 'foreign-job' }));
    }
    return actual.readFile(...args);
  }) };
});

describe('background service Windows process custody', () => {
  const envScope = createSpawnHappyCliEnvScope();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
    envScope.restore();
    boundary.spawn.mockReset(); boundary.execFile.mockReset(); boundary.handshakeValid = true;
  });

  async function withCarrier(run: (child: EventEmitter & { stdin: PassThrough; stdout: PassThrough }) => Promise<void>) {
    await withTempHappyCliEntrypoint(async (entrypoint) => {
      if (!platform) throw new Error('Expected configurable process platform');
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined, HAPPIER_MANAGED_NODE_BIN: process.execPath,
      });
      const child = Object.assign(new EventEmitter(), { pid: 45_678, stdin: new PassThrough(), stdout: new PassThrough() });
      boundary.spawn.mockImplementation((_command: string, args: string[]) => {
        boundary.job = args.find(arg => arg.startsWith('--job='))!.slice('--job='.length);
        queueMicrotask(() => child.stdout.write(Buffer.from('early-frame')));
        // Narrow fixture cast at the genuine child-process boundary.
        return child as unknown as ChildProcess;
      });
      boundary.execFile.mockResolvedValue({ stdout: '{"state":"absent"}', stderr: '' });
      await run(child);
    });
  }

  it('uses the assigned target PID, preserves pre-handshake output and awaits physical carrier exit', async () => {
    await withCarrier(async child => {
      const channel = await spawnBackgroundServiceProcessChannel({ serviceId: 'indexer' });
      expect(channel.pid).toBe(67_890);
      const chunks: Buffer[] = [];
      channel.onData(chunk => chunks.push(chunk));
      expect(Buffer.concat(chunks).toString('utf8')).toBe('early-frame');
      expect(boundary.spawn.mock.calls[0]?.[1]).not.toContain('--wait-for-job-empty');

      let closed = false;
      const closing = channel.close().then(() => { closed = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(closed).toBe(false);
      child.emit('exit', 0, null);
      await closing;
      expect(boundary.execFile.mock.calls[0]?.[1]).toEqual(['terminate', `--job=${boundary.job}`, '--timeout-ms=5000']);
      await expect(channel.waitForTermination()).resolves.toEqual({ type: 'exited', code: 0 });
    });
  });

  it('rejects foreign assignment evidence and cleans the owned Job before refusing admission', async () => {
    await withCarrier(async child => {
      boundary.handshakeValid = false;
      boundary.execFile.mockImplementation(async () => {
        child.emit('exit', 1, null);
        return { stdout: '{"state":"absent"}', stderr: '' };
      });
      await expect(spawnBackgroundServiceProcessChannel({ serviceId: 'indexer' })).rejects.toMatchObject({
        code: 'background_service_process_custody_failed',
      });
      expect(boundary.execFile.mock.calls[0]?.[1]).toContain(`--job=${boundary.job}`);
    });
  });

  it('retains unconfirmed cleanup for an explicit retry after carrier exit', async () => {
    await withCarrier(async child => {
      const channel = await spawnBackgroundServiceProcessChannel({ serviceId: 'indexer' });
      boundary.execFile.mockResolvedValue({ stdout: '{"state":"members-remaining"}', stderr: '' });
      child.emit('exit', 0, null);
      await expect(channel.waitForTermination()).rejects.toMatchObject({ code: 'background_service_process_termination_incomplete' });
      boundary.execFile.mockResolvedValue({ stdout: '{"state":"absent"}', stderr: '' });
      await expect(channel.terminate()).resolves.toBeUndefined();
    });
  });
});
