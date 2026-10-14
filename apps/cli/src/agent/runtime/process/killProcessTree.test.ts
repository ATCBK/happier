import { describe, it, expect, vi } from 'vitest';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import psList from 'ps-list';
import { withTempDir } from '@/testkit/fs/tempDir';

// Process enumeration is an OS boundary; preserve the real listing outside the controlled discovery race.
vi.mock('ps-list', async importOriginal => {
  const actual = await importOriginal<typeof import('ps-list')>();
  return { ...actual, default: vi.fn(actual.default) };
});

import { isPidAlive, spawnInlineNodeParentWithChild, spawnInlineNodeTestProcess, waitForProcessExit } from '@/testkit/process/spawn';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

describe('killProcessTree', () => {
  it.runIf(process.platform !== 'win32')('does not claim a stopped tree when its root exits during descendant discovery', async () => {
    await withTempDir('process-tree-discovery-exit-', async directory => {
      const ackPath = join(directory, 'provider-alive');
      const { parent, childPid } = await spawnInlineNodeParentWithChild(`
        process.on('SIGUSR2', () => require('node:fs').writeFileSync(${JSON.stringify(ackPath)}, 'alive'));
        setInterval(() => {}, 1000);
      `);
      const enumerate = vi.mocked(psList).getMockImplementation();
      if (!enumerate) throw new Error('Expected the real process enumeration boundary');
      vi.mocked(psList).mockImplementationOnce(async () => {
        const exited = once(parent, 'exit');
        parent.kill('SIGKILL');
        await exited;
        return await enumerate();
      });
      try {
        const result = await killProcessTree(parent, { graceMs: 25 });
        process.kill(childPid, 'SIGUSR2');
        await vi.waitFor(async () => expect(await readFile(ackPath, 'utf8')).toBe('alive'));
        expect(result).toEqual({ rootObservedAlive: false });
      } finally {
        vi.mocked(psList).mockImplementation(enumerate);
        parent.kill('SIGKILL');
        await killProcessTree({ pid: childPid }, { graceMs: 25 });
      }
    });
  });

  it('does not mistake a closed owned child for an executing process when its PID remains signalable', async () => {
    const child = spawnInlineNodeTestProcess('process.exit(0)');
    await once(child, 'close');
    const signal = process.kill.bind(process);
    // Genuine OS boundary vector: defunct children can remain signalable until reaped.
    // This fixture has an independent child-close witness, not an executing provider.
    const defunct = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => (
      pid === child.pid ? true : signal(pid, requestedSignal)
    ));
    try {
      await expect(killProcessTree(child, { graceMs: 25 })).resolves.toEqual({ rootObservedAlive: false });
    } finally {
      defunct.mockRestore();
    }
  });

  it('rejects unverified termination when the OS denies signalling and probing the known root', async () => {
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const signal = process.kill.bind(process);
    // Genuine OS signal/probe denial, restricted to this test's real owned root.
    const denied = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
      if (pid === child.pid) throw Object.assign(new Error('private-native-value'), { code: 'EPERM' });
      return signal(pid, requestedSignal);
    });
    try {
      await expect(killProcessTree(child, { graceMs: 25 })).rejects.toMatchObject({
        code: 'process_tree_termination_incomplete',
      });
    } finally {
      denied.mockRestore();
      child.kill('SIGKILL');
      await waitForProcessExit(child.pid!, { timeoutMs: 3_000 });
    }
  });

  it('kills a process and its descendants (posix)', async () => {
    if (process.platform === 'win32') return;

    const { parent, childPid } = await spawnInlineNodeParentWithChild();

    expect(parent.pid).toBeTruthy();
    expect(childPid).toBeGreaterThan(0);
    expect(isPidAlive(parent.pid!)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    await expect(killProcessTree(parent, { graceMs: 250 })).resolves.toEqual({ rootObservedAlive: true });

    await expect(waitForProcessExit(parent.pid!, { timeoutMs: 10_000 })).resolves.toBe(true);
    await expect(waitForProcessExit(childPid, { timeoutMs: 10_000 })).resolves.toBe(true);
  }, 30_000);
});
