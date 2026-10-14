import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import {
  hasObservableDaemonStartProcessExited,
  hasObservableDaemonStartProcessRunning,
  waitForDaemonRunningWithinBudget,
} from './waitForDaemonRunningWithinBudget';

describe('waitForDaemonRunningWithinBudget', () => {
  it('charges slow readiness probes to the existing wait checkpoint', async () => {
    let elapsedMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    const timeoutMs = 1_000;
    const probeMs = 600;
    await expect(waitForDaemonRunningWithinBudget({
      isRunning: async () => { elapsedMs += probeMs; return false; },
      timeoutMs,
      pollMs: 100,
      sleep: async (ms) => { elapsedMs += ms; },
    })).resolves.toBe(false);
    expect(elapsedMs).toBeLessThanOrEqual(timeoutMs + probeMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('observes POSIX daemon process exits without treating the Windows launcher exit as fatal', () => {
    const exited = { exitCode: 1, signalCode: null };

    expect(hasObservableDaemonStartProcessExited(exited, 'darwin')).toBe(true);
    expect(hasObservableDaemonStartProcessExited(exited, 'linux')).toBe(true);
    expect(hasObservableDaemonStartProcessExited(exited, 'win32')).toBe(false);
    expect(hasObservableDaemonStartProcessExited({ exitCode: null, signalCode: null }, 'darwin'))
      .toBe(false);
  });

  it('observes the detached Windows daemon PID instead of the completed PowerShell launcher', () => {
    const child = { exitCode: 0, signalCode: null, detachedDaemonPid: process.pid };
    expect(hasObservableDaemonStartProcessExited(child, 'win32')).toBe(false);
    expect(hasObservableDaemonStartProcessRunning(child, 'win32')).toBe(true);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('process is absent'), { code: 'ESRCH' });
    });
    expect(hasObservableDaemonStartProcessExited(child, 'win32')).toBe(true);
    expect(hasObservableDaemonStartProcessRunning(child, 'win32')).toBe(false);
  });

  it('checks once more after the final sleep before giving up on the budget', async () => {
    const isRunning = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    let elapsedMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    const sleep = vi.fn(async (ms: number) => { elapsedMs += ms; });

    await expect(waitForDaemonRunningWithinBudget({
      isRunning,
      timeoutMs: 200,
      pollMs: 100,
      sleep,
    })).resolves.toBe(true);

    expect(isRunning).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });

  it('stops polling when the spawned daemon process has already exited', async () => {
    const isRunning = vi.fn(async () => false);
    const shouldAbort = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    let elapsedMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    const sleep = vi.fn(async (ms: number) => { elapsedMs += ms; });

    await expect(waitForDaemonRunningWithinBudget({
      isRunning,
      shouldAbort,
      timeoutMs: 900_000,
      pollMs: 100,
      sleep,
    })).resolves.toBe(false);

    expect(isRunning).toHaveBeenCalledTimes(2);
    expect(shouldAbort).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('backs off repeated misses while respecting the startup budget', async () => {
    let elapsedMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    const sleeps: number[] = [];
    await expect(waitForDaemonRunningWithinBudget({
      isRunning: async () => false,
      timeoutMs: 2_600,
      pollMs: 100,
      sleep: async (ms) => { elapsedMs += ms; sleeps.push(ms); },
    })).resolves.toBe(false);
    expect(sleeps).toEqual([100, 200, 400, 800, 1_000, 100]);
  });

  it('keeps waiting for real readiness while the owned startup process survives its budget', async () => {
    const child = spawn(process.execPath, ['-e', `
      process.stdout.write('starting');
      setTimeout(() => process.stdout.write('ready'), 50);
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'pipe', 'ignore'] });
    let ready = false;
    child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('ready')) ready = true; });
    let checkpoints = 0;
    try {
      await once(child.stdout, 'data');
      await expect(waitForDaemonRunningWithinBudget({
        isRunning: async () => ready,
        shouldAbort: () => hasObservableDaemonStartProcessExited(child),
        isStillStarting: () => !hasObservableDaemonStartProcessExited(child),
        onStillStarting: () => { checkpoints += 1; },
        timeoutMs: 5,
        pollMs: 1,
      })).resolves.toBe(true);
      expect(checkpoints).toBeGreaterThan(0);
    } finally {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });

  it('ends an extended startup wait when its process exits before readiness', async () => {
    let elapsedMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsedMs);
    let starting = true;
    let checkpoints = 0;
    await expect(waitForDaemonRunningWithinBudget({
      isRunning: async () => false,
      shouldAbort: () => !starting,
      isStillStarting: () => starting,
      onStillStarting: () => { checkpoints += 1; },
      timeoutMs: 5,
      pollMs: 5,
      sleep: async (ms) => { elapsedMs += ms; if (checkpoints > 0) starting = false; },
    })).resolves.toBe(false);
    expect(checkpoints).toBe(1);
  });
});
