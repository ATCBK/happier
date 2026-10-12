import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { spawnSleepyDetachedProcess, withConfiguredDaemonTestHome } from './testkit/fakeDaemonLifecycle.testkit';
import * as doctor from './doctor';
import * as controlClient from './controlClient';
import * as multiDaemon from './multiDaemon';

const probe = vi.hoisted(() => ({ deniedPid: 0 }));

// Process command-line reads are OS boundaries. Keep the lifecycle classifier real
// while reproducing an owner whose process presence is visible but identity is unreadable.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === `/proc/${probe.deniedPid}/cmdline`) {
        throw Object.assign(new Error('command line unavailable'), { code: 'EACCES' });
      }
      return actual.open(...args);
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]) === `/proc/${probe.deniedPid}/cmdline`) {
        throw Object.assign(new Error('command line unavailable'), { code: 'EACCES' });
      }
      return actual.readFile(...args);
    },
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if ((args[0] === 'ps' || args[0] === 'powershell.exe') && args[1]?.some((arg) => arg.includes(String(probe.deniedPid)))) {
        throw Object.assign(new Error('process inventory unavailable'), { code: 'EACCES' });
      }
      return actual.execFileSync(...args);
    },
  };
});

vi.mock('@happier-dev/cli-common/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    if (probe.deniedPid && args[1]?.[0] === 'process-census') {
      throw Object.assign(new Error('process inventory unavailable'), { code: 'EACCES' });
    }
    return await actual.execFileWithDeadline(...args);
  } };
});

describe('unverified daemon startup ownership', () => {
  it('keeps stale unreadable legacy ownership fail-closed through the persistence owner', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-stale-unverified-' }, async ({ homeDir }) => {
      const child = spawnSleepyDetachedProcess(['/repo/dist/index.mjs', 'daemon', 'start-sync']);
      probe.deniedPid = child.pid;
      const lockPath = join(homeDir, 'servers', configuration.activeServerId, 'daemon.state.json.lock');
      try {
        mkdirSync(dirname(lockPath), { recursive: true });
        writeFileSync(lockPath, String(child.pid));
        const stale = new Date(Date.now() - 10 * 60_000);
        utimesSync(lockPath, stale, stale);
        const { classifyDaemonLifecycleProcessByPid } = doctor;
        expect(await classifyDaemonLifecycleProcessByPid(child.pid)).toEqual({ kind: 'unknown' });
        const { inspectDaemonRunningStateAndCleanupStaleState, stopDaemon } = controlClient;
        expect(await inspectDaemonRunningStateAndCleanupStaleState()).toMatchObject({ status: 'starting', pid: child.pid });
        await expect(stopDaemon()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', reason: 'startup_in_progress', pid: child.pid });
        const { stopAllDaemonsBestEffort } = multiDaemon;
        await expect(stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', reason: 'startup_in_progress', pid: child.pid });
        expect(process.kill(child.pid, 0)).toBe(true);
      } finally {
        probe.deniedPid = 0;
        await child.kill();
      }
    });
  });
});
