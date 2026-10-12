import { describe, expect, it, vi } from 'vitest';
import { hashProcessCommand } from '@happier-dev/cli-common/processInstance';
import type { ProcessCensusRow } from '@/processes/census/processCensus';

import {
  compareProcessGenerationIdentities,
  processGenerationMatches,
  processGenerationProvesReuse,
  readProcessIdentityByPid,
  type ReadProcessIdentityByPidDependencies,
} from './processIdentity';

describe('process generation identity', () => {
  it('uses process start time as generation identity independently of command drift', () => {
    expect(processGenerationMatches(1_000, 1_000)).toBe(true);
    expect(processGenerationProvesReuse(1_000, 2_000)).toBe(true);
    expect(processGenerationProvesReuse(undefined, 2_000)).toBe(false);
    expect(processGenerationProvesReuse(1_000, undefined)).toBe(false);
  });
});

function helperSnapshot(rows: readonly unknown[]): string {
  return JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 8, rows: [
    { pid: process.pid, ppid: 1, start: { startTimeMs: 1000 }, principal: { kind: 'sid', value: 'S-1-5-21-1' }, name: 'daemon', memory: null, cpuTimeUs: null },
    ...rows,
  ] });
}

function helperRow(overrides: Partial<ProcessCensusRow> = {}): ProcessCensusRow {
  return { pid: 777, ppid: 12, start: { startTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56, 123) },
    principal: { kind: 'sid', value: 'S-1-5-21-1' }, name: 'provider.exe', memory: null, cpuTimeUs: null, ...overrides };
}

describe('readProcessIdentityByPid', () => {
  it('preserves native Windows millisecond identity and original command hashing input', async () => {
    const commandLine = '  "C:\\Tools\\provider.exe" serve --hostname=127.0.0.1 --port=43111  ';
    const execFile = vi.fn(async () => ({ stdout: helperSnapshot([helperRow({
      commandLine, argv: ['C:\\Tools\\provider.exe', 'serve'], executablePath: 'C:\\Tools\\provider.exe',
    })]) }));
    const identity = await readProcessIdentityByPid(777, {
      platform: 'win32', execFile, helperExecutablePath: '/helper',
    });
    expect(identity).toMatchObject({
      pid: 777, ppid: 12, processStartTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56, 123),
      command: commandLine.trim(), executablePath: 'C:\\Tools\\provider.exe',
      processOwnership: 'self', ownerSid: 'S-1-5-21-1', currentUserSid: 'S-1-5-21-1',
    });
    expect(hashProcessCommand(identity!.command)).toBe(hashProcessCommand(commandLine.trim()));
    expect(hashProcessCommand(identity!.command)).not.toBe(hashProcessCommand('C:\\Tools\\provider.exe serve'));
  });

  it.each([
    ['access denied', Object.assign(new Error('Access is denied'), { code: 'EACCES' })],
    ['timeout', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })],
    ['cancellation', Object.assign(new Error('aborted'), { name: 'AbortError' })],
  ])('fails closed when native process identity lookup reports %s', async (_label, error) => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'win32', helperExecutablePath: '/helper', execFile: async () => { throw error; },
    })).resolves.toBeNull();
  });

  it('fails closed when the requested PID is missing', async () => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'win32', helperExecutablePath: '/helper',
      execFile: async () => ({ stdout: helperSnapshot([helperRow({ pid: 778 })]) }),
    })).resolves.toBeNull();
  });

  it('fails closed when the census has no reading process', async () => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'win32', helperExecutablePath: '/helper',
      execFile: async () => ({ stdout: JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 8, rows: [helperRow()] }) }),
    })).resolves.toBeNull();
  });

  it('fails closed when a native row has no birth evidence', async () => {
    const { start: _start, ...row } = helperRow();
    await expect(readProcessIdentityByPid(777, {
      platform: 'win32', helperExecutablePath: '/helper',
      execFile: async () => ({ stdout: helperSnapshot([row]) }),
    })).resolves.toBeNull();
  });

  it('retains Windows birth evidence without command or executable path', async () => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'win32', helperExecutablePath: '/helper',
      execFile: async () => ({ stdout: helperSnapshot([helperRow()]) }),
    })).resolves.toMatchObject({ pid: 777, processStartTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56, 123), command: '' });
  });

  it('keeps an observed foreign principal identifiable without private enrichment', async () => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'win32', helperExecutablePath: '/helper',
      execFile: async () => ({ stdout: helperSnapshot([helperRow({ principal: { kind: 'sid', value: 'S-1-5-21-2' } })]) }),
    })).resolves.toMatchObject({ pid: 777, processStartTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56, 123), command: '', processOwnership: 'other' });
  });

  it.each(['', 'unknown'])('retains Linux birth evidence without a command (%s)', async (command) => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'linux', linuxBoundary: {
        readFile: async (path) => path.endsWith('/stat')
          ? '777 (runner) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 12345 22'
          : path.endsWith('/status') ? 'Uid: 1000 1000 1000 1000' : path.endsWith('/cmdline') ? command : '',
        readdir: async () => [], readlink: async () => '/repo',
      },
    })).resolves.toMatchObject({ pid: 777, processStartTimeMs: 190, command: '' });
  });

  it('refuses a Linux table that has the target birth evidence but omits the reading process', async () => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'linux', linuxBoundary: {
        readFile: async (path) => {
          if (path === '/proc/777/stat') return '777 (runner) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 12345 22';
          throw Object.assign(new Error('missing process'), { code: 'ENOENT' });
        }, readdir: async () => [], readlink: async () => '/repo',
      },
    })).resolves.toBeNull();
  });

  it('preserves Darwin whole-second birth time independently of native subsecond generation', async () => {
    await expect(readProcessIdentityByPid(777, {
      platform: 'darwin', helperExecutablePath: '/helper', execFile: async () => ({ stdout: helperSnapshot([helperRow({
        start: { startTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56), native: 'darwin-proc:777:1751286896:123456' }, argv: [],
      })]) }),
    })).resolves.toMatchObject({ pid: 777, processStartTimeMs: Date.UTC(2025, 5, 30, 12, 34, 56), command: '' });
  });

  it('keeps Linux generation stable across boot wall-time shifts and detects changed start ticks', async () => {
    const files = new Map<string, string>([
      ['/proc/stat', 'cpu  1 2 3\nbtime 1717171000\n'],
      ['/proc/777/stat', '777 (provider) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 12345 22'],
      ['/proc/777/cmdline', 'provider\u0000serve\u0000--port=43111\u0000'],
    ]);
    const dependencies = {
      platform: 'linux', linuxBoundary: {
        readFile: async (path) => {
          if (path.endsWith('/status')) return 'Uid: 1000 1000 1000 1000';
          if (path === `/proc/${process.pid}/stat`) return files.get('/proc/777/stat')!;
          const value = files.get(path);
          if (value === undefined) throw new Error(`missing ${path}`);
          return value;
        }, readdir: async () => [], readlink: async (path) => {
          if (path === '/proc/777/cwd') return '/repo';
          throw new Error(`missing ${path}`);
        },
      },
    } satisfies ReadProcessIdentityByPidDependencies;
    const first = await readProcessIdentityByPid(777, dependencies);
    expect(first).toMatchObject({ pid: 777, ppid: 1, processStartTimeMs: 190, command: 'provider serve --port=43111', cwd: '/repo' });
    files.set('/proc/stat', 'cpu  1 2 3\nbtime 1717170999\n');
    const afterClockStep = await readProcessIdentityByPid(777, dependencies);
    expect(processGenerationMatches(first?.processStartTimeMs, afterClockStep?.processStartTimeMs)).toBe(true);
    files.set('/proc/777/stat', '777 (provider) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 20 12345 22');
    const reusedPid = await readProcessIdentityByPid(777, dependencies);
    expect(processGenerationProvesReuse(first?.processStartTimeMs, reusedPid?.processStartTimeMs)).toBe(true);
  });
});

describe('compareProcessGenerationIdentities', () => {
  it('delegates the legacy numeric precision policy to cli-common', () => {
    expect(compareProcessGenerationIdentities('41:1754041400000', '41:1754041400000', 'darwin'))
      .toBe('ambiguous');
    expect(compareProcessGenerationIdentities('41:1754041400000', '41:1754041400000', 'linux'))
      .toBe('same');
  });

  it('proves reuse when a legacy record observes a different birth second', () => {
    expect(compareProcessGenerationIdentities(
      '41:1754041400000',
      '41:1754041401000',
      'darwin',
    )).toBe('reused');
    expect(compareProcessGenerationIdentities('41:1000', '41:2000', 'linux')).toBe('reused');
  });

  it('fails closed on unparsable or pid-mismatched identities', () => {
    expect(compareProcessGenerationIdentities('garbage', '41:1000')).toBe('ambiguous');
    expect(compareProcessGenerationIdentities('41:1000', '42:1000'))
      .toBe('ambiguous');
    expect(compareProcessGenerationIdentities('41:1000', '')).toBe('ambiguous');
    expect(compareProcessGenerationIdentities('garbage', 'garbage')).toBe('ambiguous');
    expect(compareProcessGenerationIdentities(
      '9007199254740992:1000',
      '9007199254740992:1000',
      'linux',
    )).toBe('ambiguous');
  });

  it('decides tagged Darwin native identities exactly, including same-second reuse', () => {
    const sameGeneration = 'darwin-proc:41:1754041400:123456';
    expect(compareProcessGenerationIdentities(sameGeneration, sameGeneration, 'darwin'))
      .toBe('same');
    // The whole-second witness can never decide this case; the subsecond
    // witness must.
    expect(compareProcessGenerationIdentities(
      'darwin-proc:41:1754041400:123456',
      'darwin-proc:41:1754041400:654321',
      'darwin',
    )).toBe('reused');
    expect(compareProcessGenerationIdentities(
      'darwin-proc:41:1754041400:123456',
      'darwin-proc:41:1754041401:000001',
      'darwin',
    )).toBe('reused');
    expect(compareProcessGenerationIdentities(
      'darwin-proc:41:1754041400:123456',
      'darwin-proc:42:1754041400:123456',
      'darwin',
    )).toBe('ambiguous');
  });

  it('fences a tagged record against a legacy record and decides tagged job custody', () => {
    expect(compareProcessGenerationIdentities(
      '41:1754041400000',
      'darwin-proc:41:1754041400:123456',
      'darwin',
    )).toBe('ambiguous');
    expect(compareProcessGenerationIdentities(
      'winjob:Local\\happier-svc09-a',
      'winjob:Local\\happier-svc09-a',
      'win32',
    )).toBe('same');
    expect(compareProcessGenerationIdentities(
      'winjob:Local\\happier-svc09-a',
      'winjob:Local\\happier-svc09-b',
      'win32',
    )).toBe('reused');
    expect(compareProcessGenerationIdentities(
      'winjob:Local\\happier-svc09-a',
      '41:1754041400000',
      'win32',
    )).toBe('ambiguous');
  });

});
