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
  it.runIf(process.platform !== 'win32').each(['lost', 'captured'] as const)('does not signal an exited root while cleaning %s descendants discovered across its exit', async discovery => {
    await withTempDir('process-tree-discovery-exit-', async directory => {
      const ackPath = join(directory, 'provider-alive');
      const { parent, childPid } = await spawnInlineNodeParentWithChild(`
        process.on('SIGUSR2', () => require('node:fs').writeFileSync(${JSON.stringify(ackPath)}, 'alive'));
        setInterval(() => {}, 1000);
      `);
      const enumerate = vi.mocked(psList).getMockImplementation();
      if (!enumerate) throw new Error('Expected the real process enumeration boundary');
      vi.mocked(psList).mockImplementationOnce(async () => {
        const captured = discovery === 'captured' ? await enumerate() : undefined;
        const exited = once(parent, 'exit');
        parent.kill('SIGKILL');
        await exited;
        return captured ?? await enumerate();
      });
      const signal = process.kill.bind(process);
      const postExitRootSignals: unknown[] = [];
      // A numeric PID can be reused after this real child exits; never signal its replacement.
      const recycled = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
        if (pid === parent.pid && (parent.exitCode !== null || parent.signalCode !== null)) {
          postExitRootSignals.push(requestedSignal);
          return true;
        }
        return signal(pid, requestedSignal);
      });
      try {
        const result = await killProcessTree(parent, { graceMs: 25 });
        if (discovery === 'lost') {
          process.kill(childPid, 'SIGUSR2');
          await vi.waitFor(async () => expect(await readFile(ackPath, 'utf8')).toBe('alive'));
        } else {
          await expect(waitForProcessExit(childPid, { timeoutMs: 3_000 })).resolves.toBe(true);
        }
        expect(postExitRootSignals).toEqual([]);
        expect(result).toEqual({ rootObservedAlive: false });
      } finally {
        recycled.mockRestore();
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
    // Genuine OS boundary vector: a reused numeric PID remains signalable after its owned child closes.
    const defunct = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => (
      pid === child.pid ? true : signal(pid, requestedSignal)
    ));
    vi.mocked(psList).mockClear();
    try {
      await expect(killProcessTree(child, { graceMs: 25 })).resolves.toEqual({ rootObservedAlive: false });
      expect(psList).not.toHaveBeenCalled();
      expect(defunct).not.toHaveBeenCalled();
    } finally {
      defunct.mockRestore();
    }
  });

  it.runIf(process.platform !== 'win32')('does not probe or escalate against a root that exits during grace', async () => {
    const child = spawnInlineNodeTestProcess('setInterval(() => {}, 1000)');
    const signal = process.kill.bind(process);
    const postExitRootSignals: unknown[] = [];
    const recycled = vi.spyOn(process, 'kill').mockImplementation((pid, requestedSignal) => {
      if (pid === child.pid && (child.exitCode !== null || child.signalCode !== null)) {
        postExitRootSignals.push(requestedSignal);
        return true;
      }
      return signal(pid, requestedSignal);
    });
    try {
      await expect(killProcessTree(child, { graceMs: 25 })).resolves.toEqual({ rootObservedAlive: true });
      expect(child.signalCode).toBe('SIGTERM');
      expect(postExitRootSignals).toEqual([]);
    } finally {
      recycled.mockRestore();
      child.kill('SIGKILL');
      await waitForProcessExit(child.pid!, { timeoutMs: 3_000 });
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

  it.runIf(process.platform !== 'win32')('does not leave the root stopped when its owner exits during discovery', async () => {
    const processTreePath = join(__dirname, '../../../../scripts/process_tree.cjs');
    // Real owner process: it stops its detached root, then exits before discovery settles,
    // like a provider runner that finishes shutdown while cleanup is still pending.
    const owner = spawnInlineNodeTestProcess(`
      const { spawn } = require('node:child_process');
      const { killProcessTree } = require(${JSON.stringify(processTreePath)});
      const root = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
      console.log(String(root.pid));
      const pendingDiscovery = () => new Promise(() => { setTimeout(() => process.exit(0), 100); });
      void killProcessTree(root, { graceMs: 25 }, pendingDiscovery);
    `, { stdio: ['ignore', 'pipe', 'ignore'] });
    const [output] = await once(owner.stdout!, 'data');
    const rootPid = Number(String(output).trim());
    try {
      await once(owner, 'exit');
      await expect(waitForProcessExit(rootPid, { timeoutMs: 3_000 })).resolves.toBe(true);
    } finally {
      try { process.kill(rootPid, 'SIGKILL'); } catch { /* already gone */ }
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
