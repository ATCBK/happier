import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { procfsFileHandle } from '@/testkit/process/procfsFileHandle';
import { configuration, reloadConfiguration } from '@/configuration';
import type { ProcessCensusRow } from '@/processes/census/processCensus';
const processBoundary = vi.hoisted(() => ({
  commands: [] as string[],
  command: '',
  runStates: [] as string[],
}));
const daemonCommand = '/usr/bin/node /repo/dist/index.mjs daemon start-sync';
const lockPid = 999_999_998;

// Procfs descriptors and native helper execution are OS boundaries. Classification,
// the census, lock admission and zombie-state interpretation remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => {
    const path = String(args[0]);
    if (path === `/proc/${lockPid}/cmdline`) {
      processBoundary.command = processBoundary.commands.shift() ?? '';
      return Promise.resolve(procfsFileHandle(processBoundary.command.replaceAll(' ', '\0')));
    }
    if (path === `/proc/${lockPid}/status`) {
      const uid = process.getuid?.() ?? 1000;
      return Promise.resolve(procfsFileHandle(`Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`));
    }
    if (path === `/proc/${lockPid}/stat`) {
      const state = processBoundary.commands[0] ? 'S' : processBoundary.runStates[0] ?? 'S';
      return Promise.resolve(procfsFileHandle(
        `${lockPid} (node) ${state} 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 12345 22`,
      ));
    }
    return actual.open(...args);
  } };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
    /[\\/]tools[\\/]unpacked[\\/]happier-process-custody(?:\.exe)?$/u.test(String(path))
      || actual.existsSync(path) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual,
    execFile: (command: string, args: string[], options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      if (args[0] !== 'process-census') {
        throw new Error(`Unexpected process boundary invocation: ${command}`);
      }
      // Darwin and Windows consume the same strict helper census contract.
      processBoundary.command = processBoundary.commands.shift() ?? '';
      const rows: ProcessCensusRow[] = [process.pid, lockPid].map(pid => ({
        pid, ppid: 1, start: { startTimeMs: 1000 },
        principal: { kind: process.platform === 'win32' ? 'sid' : 'uid', value: 'fixture-user' },
        name: 'node', memory: null, cpuTimeUs: null,
        ...(pid === lockPid && processBoundary.command ? { argv: processBoundary.command.split(' ') } : {}),
        state: pid === lockPid && !processBoundary.command && processBoundary.runStates[0] === 'Z' ? 'zombie' : 'sleeping',
      }));
      const stdout = JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 1, rows });
      const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, exitCode: 0, signalCode: null });
      queueMicrotask(() => { callback(null, stdout, ''); child.emit('close', 0, null); });
      return child;
    },
  };
});

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
