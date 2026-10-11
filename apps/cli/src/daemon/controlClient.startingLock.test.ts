import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { configuration, reloadConfiguration } from '@/configuration';
const processBoundary = vi.hoisted(() => ({
  commands: [] as string[],
  command: '',
  runStates: [] as string[],
}));
const daemonCommand = '/usr/bin/node /repo/dist/index.mjs daemon start-sync';
const lockPid = 999_999_998;

// Raw process inventory and process execution are OS boundaries. Classification,
// lock admission and zombie-state interpretation remain the real owners.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: (...args: Parameters<typeof actual.readFile>) => {
    if (String(args[0]) === `/proc/${lockPid}/cmdline`) {
      processBoundary.command = processBoundary.commands.shift() ?? '';
      return Promise.resolve(Buffer.from(processBoundary.command.replaceAll(' ', '\0')));
    }
    return actual.readFile(...args);
  } };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (String(args[0]).toLowerCase().endsWith('powershell.exe')
        && args[1]?.some(arg => arg.includes(String(lockPid)))) {
        processBoundary.command = processBoundary.commands.shift() ?? '';
        return JSON.stringify(processBoundary.command
          ? [{ ProcessId: lockPid, Name: 'node.exe', CommandLine: processBoundary.command }]
          : []);
      }
      if (args[0] === 'ps' && args[1]?.includes(String(lockPid))) {
        if (process.platform !== 'linux' && args[1].includes('command=')) {
          processBoundary.command = processBoundary.commands.shift() ?? '';
        }
        return args[1].includes('comm=') ? (processBoundary.command ? 'node' : '') : processBoundary.command;
      }
      return actual.execFileSync(...args);
    },
    execFile: (command: string, args: string[], options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      if (command !== 'ps' || !args.includes('state=')) {
        throw new Error('Unexpected process-state boundary invocation');
      }
      const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, exitCode: 0, signalCode: null });
      queueMicrotask(() => { callback(null, processBoundary.runStates.shift() ?? 'S', ''); child.emit('close', 0, null); });
      return child;
    },
  };
});
vi.mock('ps-list', () => ({ default: async () => [] }));

let controlClient: typeof import('./controlClient');
let persistence: typeof import('@/persistence');
beforeAll(async () => {
  [controlClient, persistence] = await Promise.all([import('./controlClient'), import('@/persistence')]);
}, 300_000);

describe('daemon control client startup lock inspection', () => {
  const envKeys = ['HAPPIER_HOME_DIR'] as const;
  let envScope = createEnvKeyScope(envKeys);

  beforeEach(() => {
    const actualKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === lockPid && signal === 0) return true;
      return actualKill(pid, signal);
    });
  });

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    processBoundary.commands = [];
    processBoundary.command = '';
    processBoundary.runStates = [];
    vi.restoreAllMocks();
    reloadConfiguration();
  });

  it('treats a fresh live unclassified lock holder as daemon startup in progress', async () => {
    await withTempDir('happier-daemon-control-fresh-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      reloadConfiguration();
      const { inspectDaemonRunningStateAndCleanupStaleState } = controlClient;
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, `${lockPid}\n`, 'utf8');

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: lockPid,
      });
      unlinkSync(configuration.daemonLockFile);
    });
  }, 120_000);

  it('defers stale dead state to a different live lifecycle lock holder', async () => {
    await withTempDir('happier-daemon-stale-state-live-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      reloadConfiguration();
      const { inspectDaemonRunningStateAndCleanupStaleState } = controlClient;
      const { writeDaemonState } = persistence;
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, String(lockPid), 'utf8');
      writeDaemonState({ pid: 999_999_999, httpPort: 3025, startedAt: Date.now(), startedWithCliVersion: '0.2.10' });

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: lockPid,
      });
    });
  }, 120_000);

  it('keeps an old live unclassified lock holder fail-closed', async () => {
    await withTempDir('happier-daemon-control-stale-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      reloadConfiguration();
      const { inspectDaemonRunningStateAndCleanupStaleState } = controlClient;
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, `${lockPid}\n`, 'utf8');
      const old = new Date(Date.now() - 120_000);
      utimesSync(configuration.daemonLockFile, old, old);

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: lockPid,
      });
      unlinkSync(configuration.daemonLockFile);
    });
  }, 120_000);

  it('keeps a previously admitted live daemon startup after the lock freshness window', async () => {
    await withTempDir('happier-daemon-control-slow-admitted-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      reloadConfiguration();
      const { inspectDaemonRunningStateAndCleanupStaleState } = controlClient;
      processBoundary.commands = [daemonCommand, ''];
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, `${lockPid}\n`, 'utf8');
      const old = new Date(Date.now() - 120_000);
      utimesSync(configuration.daemonLockFile, old, old);

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: lockPid,
      });
      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: lockPid,
      });
    });
  }, 120_000);

  it.skipIf(process.platform === 'win32')('does not retain startup admission after the lock holder becomes a zombie', async () => {
    await withTempDir('happier-daemon-control-zombie-admitted-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      reloadConfiguration();
      const { inspectDaemonRunningStateAndCleanupStaleState } = controlClient;
      processBoundary.commands = [daemonCommand, ''];
      processBoundary.runStates = ['Z'];
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, `${lockPid}\n`, 'utf8');

      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'starting',
        pid: lockPid,
      });
      await expect(inspectDaemonRunningStateAndCleanupStaleState()).resolves.toEqual({
        status: 'not-running',
      });
    });
  }, 120_000);

  it('does not stop an admitted live startup before state publication', async () => {
    await withTempDir('happier-daemon-control-stop-admitted-lock-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      reloadConfiguration();
      const { stopDaemon } = controlClient;
      processBoundary.commands = [daemonCommand];
      mkdirSync(dirname(configuration.daemonLockFile), { recursive: true });
      writeFileSync(configuration.daemonLockFile, `${lockPid}\n`, 'utf8');
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      await expect(stopDaemon()).rejects.toMatchObject({
        code: 'daemon_stop_incomplete',
        reason: 'startup_in_progress',
        pid: lockPid,
      });

      expect(killSpy).toHaveBeenCalledWith(lockPid, 0);
      expect(killSpy).not.toHaveBeenCalledWith(lockPid, 'SIGTERM');
    });
  }, 120_000);
});
