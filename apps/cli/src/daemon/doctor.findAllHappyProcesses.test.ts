import { afterEach, describe, expect, it, vi } from 'vitest';

import { spawnInlineNodeTestProcess } from '@/testkit/process/spawn';

describe.skipIf(process.platform !== 'linux')('doctor census snapshots', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('never adopts a departed root from an earlier classified snapshot', async () => {
    vi.resetModules();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const child = spawnInlineNodeTestProcess('/* /repo/dist/index.mjs daemon start-sync */ setInterval(() => {}, 1000)');
    try {
      const { findAllHappyProcesses, classifyProcessByPid } = await import('./doctor');
      const snapshots = await Promise.all([findAllHappyProcesses(), findAllHappyProcesses()]);
      expect(snapshots[0]).toEqual(snapshots[1]);
      expect(snapshots[0].some(row => row.pid === child.pid)).toBe(true);
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill();
      await exited;
      await expect(classifyProcessByPid(child.pid!)).resolves.toEqual({ kind: 'unknown' });
    } finally {
      clock.mockRestore();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });
});
