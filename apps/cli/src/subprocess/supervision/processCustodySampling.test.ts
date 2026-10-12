import { describe, expect, it, vi } from 'vitest';
import { createProcessCustodySamplingInvoker, type ProcessCustodyExecFile } from './processCustody';

describe('native sampling helper failure recovery', () => {
    it('backs off failed launches until the next minute, then recovers without disabling the helper', async () => {
        const execFile = vi.fn<ProcessCustodyExecFile>().mockRejectedValueOnce(new Error('helper exited')).mockResolvedValue({ stdout: '{}', stderr: '' });
        const invoke = createProcessCustodySamplingInvoker({ execFile, resolveExecutable: () => '/helper' });
        expect(await invoke({ command: 'vitals-sample', sampledAt: 10_000 })).toEqual({ state: 'unavailable', reason: 'helper_failing' });
        expect(await invoke({ command: 'vitals-sample', sampledAt: 12_000 })).toEqual({ state: 'unavailable', reason: 'helper_failing' });
        expect(execFile).toHaveBeenCalledTimes(1); // VIT-18 / M-13's specified spawn budget.
        expect(await invoke({ command: 'vitals-sample', sampledAt: 60_000 })).toEqual({ state: 'ready', stdout: '{}' });
        expect(await invoke({ command: 'vitals-sample', sampledAt: 62_000 })).toEqual({ state: 'ready', stdout: '{}' });
    });
});
