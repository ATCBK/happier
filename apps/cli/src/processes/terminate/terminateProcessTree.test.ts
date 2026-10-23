import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as fs from 'node:fs/promises';

const procfsState = vi.hoisted(() => ({
  actual: null as null | typeof import('node:fs/promises').readdir,
  readFile: null as null | typeof import('node:fs/promises').readFile,
  open: null as null | typeof import('node:fs/promises').open,
  rejectCensus: false,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  procfsState.actual = actual.readdir;
  procfsState.readFile = actual.readFile;
  procfsState.open = actual.open;
  return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile), open: vi.fn(actual.open) };
});
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return {
    ...actual,
    execFileWithDeadline: ((command, args, options) => {
      // The native helper is the macOS/Windows OS inventory boundary; leave other commands real.
      if (procfsState.rejectCensus && args[0] === 'process-census') return Promise.reject(new Error('native census unavailable'));
      return actual.execFileWithDeadline(command, args, options);
    }) satisfies typeof actual.execFileWithDeadline,
  };
});

import {
  isPidAlive,
  spawnDetachedInlineNodeTestProcess,
  spawnInlineNodeParentWithChild,
  spawnInlineNodeTestProcess,
  waitForProcessExit,
} from '@/testkit/process/spawn';
import { terminateProcessTree } from './terminateProcessTree';
import { bindProcessLogger, Logger } from '@/ui/logger';

let restoreCensusClock: (() => void) | undefined;
function denyNativeCensus() {
  procfsState.rejectCensus = true;
  const now = Date.now;
  // Native invocation failures are retained until the next wall minute. Place this
  // OS-denial fixture before real-clock tests without resetting the census owner.
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() - 120_000);
  restoreCensusClock = () => clock.mockRestore();
}

afterEach(() => {
  if (procfsState.actual) vi.mocked(fs.readdir).mockImplementation(procfsState.actual);
  if (procfsState.readFile) vi.mocked(fs.readFile).mockImplementation(procfsState.readFile);
  if (procfsState.open) vi.mocked(fs.open).mockImplementation(procfsState.open);
  procfsState.rejectCensus = false;
  restoreCensusClock?.();
  restoreCensusClock = undefined;
});

async function waitForPidFile(filePath: string, opts: { timeoutMs: number }): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const parsed = Number.parseInt(readFileSync(filePath, 'utf8').trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for pid file ${filePath}`);
}

describe('terminateProcessTree', () => {
  it('does not invoke Windows taskkill when the authoritative census is unavailable', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformDescriptor) throw new Error('Expected process.platform to be configurable');
    const pid = 987_654_321;
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Access denied'), { code: 'EPERM' }); });
    const budgets: number[] = [];
    const stoppedTools: boolean[] = [];
    // Keep genuine filesystem I/O outside this deterministic taskkill deadline check.
    vi.mocked(fs.readFile).mockRejectedValue(new Error('procfs unavailable'));
    vi.mocked(fs.open).mockRejectedValue(new Error('procfs unavailable'));
    vi.mocked(fs.readdir).mockRejectedValue(new Error('procfs unavailable'));
    procfsState.rejectCensus = true;
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
      const result = terminateProcessTree({ pid }, {
        graceMs: 700,
        terminateWindowsTree: async (input: { timeoutMs?: number }) => new Promise<void>((_resolve, reject) => {
          if (input.timeoutMs === undefined) return; // Old owner never bounded this adapter.
          budgets.push(input.timeoutMs);
          setTimeout(() => {
            stoppedTools.push(true);
            reject(Object.assign(new Error('taskkill deadline'), { killed: true }));
          }, input.timeoutMs);
        }),
      }).then(() => 'success', (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(budgets).toEqual([]);
      expect(stoppedTools).toEqual([]);
      expect(await result).toMatchObject({ code: 'plugin_exec_termination_incomplete' });
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('refuses every signal and records incomplete cleanup when the census is unavailable', async () => {
    if (process.platform === 'win32') return; // POSIX direct-child utility boundary.
    const directory = mkdtempSync(join(tmpdir(), 'happier-kill-tree-discovery-'));
    const logPath = join(directory, 'diagnostic.log');
    const scopedLogger = new Logger({ logFilePath: logPath, allowDangerousRemoteLogging: false, pruneCurrentProcessLogs: false });
    const restoreLogger = bindProcessLogger(scopedLogger);
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    const previousPath = process.env.PATH;
    vi.mocked(fs.readdir).mockRejectedValue(new Error('private-native-value'));
    denyNativeCensus();
    process.env.PATH = ''; // Real unavailable pkill, not an internal fallback mock.
    try {
      const failure = await terminateProcessTree(parent, { graceMs: 250 }).then(() => null, (error: unknown) => error);
      expect(isPidAlive(parent.pid!)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);
      expect(failure).toMatchObject({ code: 'plugin_exec_termination_incomplete' });
      scopedLogger.flushSync();
      const diagnostic = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      expect(diagnostic).toContain('plugin_exec_termination_incomplete');
      expect(diagnostic).toMatch(/"reasons":\s*\[\s*"census_unavailable"\s*\]/);
      expect(diagnostic).not.toContain('private-native-value');
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      restoreLogger();
      for (const pid of [parent.pid!, childPid]) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects Windows termination when the process survives the forced taskkill attempt', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformDescriptor) throw new Error('Expected process.platform to be configurable');
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const exited = once(child, 'exit');

    try {
      expect(isPidAlive(child.pid!)).toBe(true);
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });

      await expect(terminateProcessTree(child, {
        graceMs: 25,
        // The OS adapter reports success without terminating the real process.
        // This exercises Windows completion admission on non-Windows test hosts.
        terminateWindowsTree: async () => undefined,
      })).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });

      expect(isPidAlive(child.pid!)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      child.kill('SIGKILL');
      await exited;
    }
  });

  it('does not accept direct-root fallback as a Windows tree proof when enumeration and taskkill both fail', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformDescriptor) throw new Error('Expected process.platform to be configurable');
    const { parent, childPid } = await spawnInlineNodeParentWithChild();
    vi.mocked(fs.readdir).mockRejectedValue(new Error('process listing unavailable'));
    denyNativeCensus();
    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
      await expect(terminateProcessTree(parent, {
        graceMs: 25,
        // Genuine Windows OS adapter denial, while direct-root signalling remains usable.
        terminateWindowsTree: async () => { throw Object.assign(new Error('taskkill denied'), { code: 'EACCES' }); },
      })).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
      expect(isPidAlive(parent.pid!)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      for (const pid of [parent.pid!, childPid]) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });

  it('does not treat a Windows taskkill adapter as proof when the census is unavailable', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformDescriptor) throw new Error('Expected process.platform to be configurable');
    const child = spawnDetachedInlineNodeTestProcess('setInterval(() => {}, 1000)', {
      stdio: 'ignore',
    });
    const terminateWindowsTree = vi.fn(async ({ pid }: { pid: number }) => {
      process.kill(-pid, 'SIGKILL');
    });
    vi.mocked(fs.readdir).mockRejectedValue(new Error('process listing unavailable'));
    denyNativeCensus();

    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
      await expect(terminateProcessTree(child, {
        graceMs: 25,
        terminateWindowsTree,
      })).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });
      expect(terminateWindowsTree).not.toHaveBeenCalled();
      expect(isPidAlive(child.pid!)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
    }
  }, 20_000);

  it('never signals a replacement PID/group after the original POSIX root exited', async () => {
    if (process.platform === 'win32') return;

    await expect(terminateProcessTree({
      pid: process.pid,
      exitCode: 0,
      signalCode: null,
    }, { graceMs: 25 })).rejects.toMatchObject({
      code: 'plugin_exec_termination_incomplete',
    });
  });

  it('ends the root and descendants without PATH process-discovery utilities (posix)', async () => {
    if (process.platform === 'win32') return;

    const { parent, childPid } = await spawnInlineNodeParentWithChild();

    expect(parent.pid).toBeTruthy();
    expect(childPid).toBeGreaterThan(0);
    expect(isPidAlive(parent.pid!)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    const previousPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await terminateProcessTree(parent, { graceMs: 250 }).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'result' in error) {
          throw new Error(`Real tree cleanup failed: ${JSON.stringify(error.result)}`, { cause: error });
        }
        throw error;
      });

      await expect(waitForProcessExit(parent.pid!, { timeoutMs: 3_000 })).resolves.toBe(true);
      await expect(waitForProcessExit(childPid, { timeoutMs: 3_000 })).resolves.toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      try {
        process.kill(parent.pid!, 'SIGKILL');
      } catch {
        // ignore
      }
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 20_000);





  it('refuses an owned detached group when the census is unavailable (posix)', async () => {
    if (process.platform === 'win32') return;

    const tempDir = mkdtempSync(join(tmpdir(), 'happier-kill-tree-'));
    const readyFile = join(tempDir, 'ready');
    const grandchildPidFile = join(tempDir, 'grandchild.pid');
    const childSource = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      'let spawned = false;',
      'process.on("SIGTERM", () => {});',
      'setTimeout(() => {',
      '  if (spawned) return;',
      '  spawned = true;',
      '  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `  fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));`,
      '}, 75);',
      `fs.writeFileSync(${JSON.stringify(readyFile)}, "1");`,
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const parent = spawnDetachedInlineNodeTestProcess(
      [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: "ignore" });`,
        'console.log(String(child.pid));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const childPid = await new Promise<number>((resolve, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('Timed out waiting for child pid')), 2_000);
      parent.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const parsed = Number.parseInt(buffer.trim().split('\n')[0] ?? '', 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
      parent.once('error', reject);
      parent.once('exit', () => reject(new Error('Parent exited before child pid was emitted')));
    });

    let grandchildPid: number | null = null;
    const previousPath = process.env.PATH;
    try {
      expect(parent.pid).toBeTruthy();
      expect(isPidAlive(parent.pid!)).toBe(true);
      expect(isPidAlive(childPid)).toBe(true);
      await waitForPidFile(readyFile, { timeoutMs: 2_000 });

      vi.mocked(fs.readdir).mockRejectedValue(new Error('process listing unavailable'));
      denyNativeCensus();
      process.env.PATH = '';

      await expect(terminateProcessTree(parent, { graceMs: 250 })).rejects.toMatchObject({ code: 'plugin_exec_termination_incomplete' });

      grandchildPid = await waitForPidFile(grandchildPidFile, { timeoutMs: 2_000 });
      expect(isPidAlive(parent.pid!)).toBe(true);
      expect(isPidAlive(grandchildPid)).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (parent.pid) {
        try {
          process.kill(-parent.pid, 'SIGKILL');
        } catch {
          // ignore
        }
        try {
          process.kill(parent.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // ignore
      }
      if (grandchildPid !== null) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // ignore
        }
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 20_000);

});
