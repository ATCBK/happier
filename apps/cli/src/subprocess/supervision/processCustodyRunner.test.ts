import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ execFile: vi.fn() }));
// The executable launch and existence check are genuine OS boundaries.
vi.mock('@happier-dev/cli-common/process', async importOriginal => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
  execFileWithDeadline: native.execFile,
}));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, existsSync: (path: import('node:fs').PathLike) =>
    String(path).endsWith('happier-process-custody.exe') || fs.existsSync(path) };
});

import { configuration } from '@/configuration';
import { formatProcessOwnerTag, PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { joinCurrentWindowsSessionProcessCustody } from './processCustody';

describe('current runner Windows custody', () => {
  it('keeps one existing holder when earliest startup and initial Session binding overlap', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const inherited = process.env[PROCESS_OWNER_ENV_KEY];
    let handles = 0;
    native.execFile.mockImplementation(async (_file: string, args: readonly string[]) => ({
      stdout: JSON.stringify({ v: 1, state: 'joined', job: args.find(arg => arg.startsWith('--job='))?.slice(6),
        pid: process.pid, holderPid: process.pid, holderStartTimeMs: 1234, holderHandle: String(++handles) }), stderr: '',
    }));
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
      delete process.env[PROCESS_OWNER_ENV_KEY];
      expect(await joinCurrentWindowsSessionProcessCustody()).toBeNull();
      process.env[PROCESS_OWNER_ENV_KEY] = formatProcessOwnerTag({ happierHomeDir: configuration.happyHomeDir,
        owner: { kind: 'session', sessionId: 'runner' } });
      const [startup, binding] = await Promise.all([joinCurrentWindowsSessionProcessCustody(), joinCurrentWindowsSessionProcessCustody()]);
      expect(startup?.state).toBe('joined');
      expect(binding).toEqual(startup);
      expect(handles).toBe(1);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      if (inherited === undefined) delete process.env[PROCESS_OWNER_ENV_KEY]; else process.env[PROCESS_OWNER_ENV_KEY] = inherited;
    }
  });
});
