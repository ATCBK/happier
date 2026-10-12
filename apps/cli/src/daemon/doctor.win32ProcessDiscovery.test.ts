import { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { censusOutput, execFileMock } = vi.hoisted(() => ({
  censusOutput: { value: '' },
  execFileMock: vi.fn(),
}));

// Native executable presence and process output are genuine OS boundaries.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (path: string) => path.endsWith('happier-process-custody.exe') || actual.existsSync(path) };
});
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: execFileMock,
}));

describe('doctor Windows census discovery', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const executable = String.raw`C:\Program Files\Happier\happier.exe`;
  const entrypoint = String.raw`C:\Program Files\Happier\package-dist\index.mjs`;
  const command = `"${executable}" "${entrypoint}" codex --started-by daemon`;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      const child = new ChildProcess();
      queueMicrotask(() => {
        Object.defineProperty(child, 'exitCode', { value: 0 });
        child.emit('exit', 0, null);
        callback(null, censusOutput.value, '');
        child.emit('close', 0, null);
      });
      return child;
    });
    censusOutput.value = JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 4, rows: [
      { pid: process.pid, ppid: 1, name: 'node.exe', start: { startTimeMs: 1000 }, principal: { kind: 'sid', value: 'S-1-5-21-1' }, memory: null, cpuTimeUs: null },
      { pid: 26316, ppid: 17692, name: 'MainThread', commandLine: command,
        argv: [executable, entrypoint, 'codex', '--started-by', 'daemon'],
        start: { startTimeMs: 2000 }, principal: { kind: 'sid', value: 'S-1-5-21-1' }, memory: { bytes: 1024, kind: 'private' }, cpuTimeUs: 500 },
    ] });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    execFileMock.mockReset();
  });

  it('recognizes a packaged session from the native command and preserves exact command bytes', async () => {
    const { findHappyProcessByPid } = await import('./doctor');
    await expect(findHappyProcessByPid(26316)).resolves.toEqual({
      pid: 26316, command, type: 'daemon-spawned-session',
    });
  });

  it('does not reinterpret unavailable native facts as an unrelated process', async () => {
    censusOutput.value = 'truncated-json';
    const { classifyProcessByPid } = await import('./doctor');
    await expect(classifyProcessByPid(26316)).resolves.toEqual({ kind: 'unknown' });
  });

  it('keeps an empty command during an exec transition unknown', async () => {
    const envelope = JSON.parse(censusOutput.value) as { rows: Array<{ pid: number; name: string; argv?: string[]; commandLine?: string }> };
    const row = envelope.rows.find(row => row.pid === 26316)!;
    row.name = 'node.exe';
    row.argv = [];
    delete row.commandLine;
    censusOutput.value = JSON.stringify(envelope);
    const { classifyProcessByPid } = await import('./doctor');
    await expect(classifyProcessByPid(26316)).resolves.toEqual({ kind: 'unknown' });
  });
});
