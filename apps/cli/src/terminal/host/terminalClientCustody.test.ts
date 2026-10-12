import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { describe, expect, it, vi } from 'vitest';

import { spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';
import { proveTerminalClientCustody } from './terminalClientCustody';

const { unreadable } = vi.hoisted(() => ({ unreadable: { value: false } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: (path: Parameters<typeof actual.readdir>[0], ...args: unknown[]) => {
    if (unreadable.value && String(path) === '/proc') return Promise.reject(Object.assign(new Error('unreadable process table'), { code: 'EACCES' }));
    return Reflect.apply(actual.readdir, actual, [path, ...args]);
  } };
});
vi.mock('@happier-dev/cli-common/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/process')>();
  return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
    if (unreadable.value && args[1]?.[0] === 'process-census') throw new Error('unreadable native process table');
    return await actual.execFileWithDeadline(...args);
  } };
});

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('terminal native client census custody', () => {
  it('requires a readable ancestry snapshot, even when foreground arguments match', async () => {
    const source = 'setInterval(() => {}, 1000)';
    const { parent, childPid } = await spawnInlineNodeParentWithChild(source);
    const fingerprint = readProcessInstanceFingerprintSync(parent.pid!);
    expect(fingerprint).toBeTruthy();
    const input = {
      launcher: { pid: parent.pid!, processInstanceFingerprint: fingerprint! },
      processes: {
        shellPid: process.pid,
        foregroundProcesses: [
          { pid: parent.pid!, argv: [process.execPath, 'terminal_launch_spec_runner.cjs'] },
          { pid: childPid, argv: [process.execPath, '-e', source] },
        ],
      },
      invocation: { command: process.execPath, args: ['-e', source] },
    };
    try {
      await expect(proveTerminalClientCustody(input)).resolves.toBe(true);
      // The OS process-table read is the boundary. Fingerprint and domain logic stay real.
      unreadable.value = true;
      try {
        await expect(proveTerminalClientCustody(input)).resolves.toBe(false);
      } finally {
        unreadable.value = false;
      }
    } finally {
      process.kill(childPid, 'SIGTERM');
      parent.kill();
      await waitForProcessExit(childPid);
      await waitForProcessExit(parent.pid!);
    }
  });
});
