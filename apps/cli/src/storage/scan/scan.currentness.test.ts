import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createStorageScanIndex } from './scanIndex';
import { createStorageScanRunner } from './scanRunner';

it('verifies authority after the awaited final policy read, before admitting a scan', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'happier-scan-authority-')));
    const index = createStorageScanIndex({ activeServerDir: home });
    let valid = true;
    let reads = 0;
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const runner = createStorageScanRunner({ index,
        readVolumes: () => [{ id: 'volume', mountPath: home, usedBytes: 0 }],
        readEnabled: async () => { if (++reads === 2) { entered(); await resume; } return true; },
        fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }),
    });
    await index.initialize([{ id: 'volume', mountPath: home, usedBytes: 0 }], true);
    try {
        const pending = runner.start({ target: { volumeId: 'volume' } }, { beforeEffect: async () => {
            if (!valid) throw Object.assign(new Error('Revoked'), { code: 'unauthorized' });
        } });
        await held;
        valid = false; release();
        await expect(pending).rejects.toMatchObject({ code: 'unauthorized' });
        expect(index.states()).toEqual([]);
    } finally { release(); await runner.dispose(); await rm(home, { recursive: true, force: true }); }
});
