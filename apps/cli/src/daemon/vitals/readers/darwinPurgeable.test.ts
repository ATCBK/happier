import { expect, it, vi } from 'vitest';
import type { ProcessCustodyExecFile } from '@/subprocess/supervision/processCustody';
import { createDarwinVolumeCapacityReader } from './darwinPurgeable';

it('reads important-usage capacity at most once per minute and never replaces free-now bytes', async () => {
    const execFile = vi.fn<ProcessCustodyExecFile>().mockResolvedValue({ stdout: '900', stderr: '' });
    const read = createDarwinVolumeCapacityReader({ execFile });
    const volumes = [{ id: 'apfs:disk3', label: 'Startup', mount: '/', apfsContainerId: 'disk3', totalBytes: 1000, availableBytes: 100 }];
    expect(await read({ volumes, monotonicMs: 0 })).toMatchObject([{ availableBytes: 100, availableIncludingPurgeableBytes: 900 }]);
    await read({ volumes, monotonicMs: 15_000 });
    expect(execFile).toHaveBeenCalledTimes(1); // VIT-25's specified system-tool budget.
    await read({ volumes, monotonicMs: 60_000 });
    expect(execFile).toHaveBeenCalledTimes(2);
});

it('leaves an empty or failed estimate absent even when free-now is zero', async () => {
    const execFile = vi.fn<ProcessCustodyExecFile>().mockResolvedValueOnce({ stdout: '', stderr: '' }).mockRejectedValueOnce(new Error('unavailable'));
    const read = createDarwinVolumeCapacityReader({ execFile });
    const volumes = [{ id: 'apfs:disk3', label: 'Startup', mount: '/', apfsContainerId: 'disk3', totalBytes: 1000, availableBytes: 0 }];
    expect(await read({ volumes, monotonicMs: 0 })).toEqual(volumes);
    expect(await read({ volumes, monotonicMs: 60_000 })).toEqual(volumes);
});
