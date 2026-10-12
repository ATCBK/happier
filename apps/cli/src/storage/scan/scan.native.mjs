// Current-source native filesystem replay; this is not an installed release.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { link, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageScanIndex } from './scanIndex.ts';
import { createStorageScanRunner } from './scanRunner.ts';
import { measureNativeDisk } from '../measure/nativeDiskMeasure.ts';

test('native resident index: exact direct relist, retained coverage, current/previous and opt-out', async () => {
    assert.ok(process.env.HAPPIER_TEST_SCAN_PAYLOAD_DIR);
    const executable = Object.getOwnPropertyDescriptor(process, 'execPath');
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-index-native-')));
    Object.defineProperty(process, 'execPath', { ...executable,
        value: join(process.env.HAPPIER_TEST_SCAN_PAYLOAD_DIR, process.platform === 'win32' ? 'happier.exe' : 'happier') });
    let runner;
    try {
        const volume = join(scratch, 'volume'); const selected = join(volume, 'selected'); const child = join(selected, 'cached');
        const replaced = join(selected, 'replaced'); const direct = join(selected, 'direct');
        await mkdir(child, { recursive: true }); await mkdir(replaced);
        await writeFile(join(child, 'data'), Buffer.alloc(8192)); await writeFile(join(replaced, 'data'), Buffer.alloc(8192));
        await writeFile(direct, Buffer.alloc(8192));
        const activeServerDir = join(scratch, 'state'); let enabled = true;
        const index = createStorageScanIndex({ activeServerDir });
        runner = createStorageScanRunner({ index, readVolumes: () => [{ id: 'native', mountPath: volume, usedBytes: 1_000_000 }],
            readEnabled: () => enabled, fullDiskAccess: () => ({ state: 'not_applicable', binary: { name: 'fixture', path: process.execPath } }) });
        await runner.initialize(); const first = await runner.start({ target: { volumeId: 'native' } }); await runner.wait(first.scanId);
        const retained = index.readNode(child);
        assert.ok(retained?.complete);
        await writeFile(join(child, 'data'), Buffer.alloc(65536)); await writeFile(direct, Buffer.alloc(65536));
        await rename(replaced, join(scratch, 'pinned-old')); await mkdir(replaced);
        await writeFile(join(replaced, 'new'), Buffer.alloc(32768));
        const drilled = await runner.start({ target: { folderPath: selected } }, { relistOnly: true });
        assert.equal(drilled.status, 'running'); await runner.wait(drilled.scanId);
        assert.equal(index.readNode(child).scannedAt, retained.scannedAt);
        assert.equal(index.readNode(child).node.size.allocatedBytes, retained.node.size.allocatedBytes);
        assert.equal(index.readNode(direct).node.size.allocatedBytes, 65536);
        assert.equal(index.readNode(join(replaced, 'data')), null); assert.equal(index.readNode(join(replaced, 'new')), null);
        assert.equal(index.readNode(replaced).complete, false); assert.equal(index.readNode(selected).complete, false);
        const paged = await runner.get({ view: { tab: 'folders', nodeId: selected, depth: 1, pageSize: 100 } });
        assert.equal(paged.state.scanId, drilled.scanId);
        assert.equal(paged.nodes.find(node => node.nodeId === child)?.deltaSincePrevious, undefined);
        assert.equal((await readdir(join(activeServerDir, 'storage', 'scans'))).filter(name => name.endsWith('.sqlite')).length, 2);
        enabled = false; await runner.initialize();
        assert.deepEqual((await readdir(join(activeServerDir, 'storage', 'scans'))).filter(name => name.endsWith('.sqlite')), []);
    } finally {
        await runner?.dispose(); Object.defineProperty(process, 'execPath', executable);
        await rm(scratch, { recursive: true, force: true });
    }
});

test('native measurement: singleton, outside hardlink, selected union and overlapping roots', async () => {
    const executable = Object.getOwnPropertyDescriptor(process, 'execPath');
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'happier-measure-native-')));
    Object.defineProperty(process, 'execPath', { ...executable,
        value: join(process.env.HAPPIER_TEST_SCAN_PAYLOAD_DIR, process.platform === 'win32' ? 'happier.exe' : 'happier') });
    try {
        const first = join(scratch, 'first'); const second = join(scratch, 'second');
        await mkdir(first); await mkdir(second);
        const file = join(first, 'ordinary'); const alias = join(second, 'alias');
        await writeFile(file, Buffer.alloc(8192));
        const singleton = await measureNativeDisk({ paths: [file] });
        assert.ok(singleton.totalAllocatedBytes > 0);
        assert.equal(singleton.totalExclusiveBytes, singleton.totalAllocatedBytes);
        if (process.platform === 'win32') {
            const casing = await measureNativeDisk({ paths: [file, file.toUpperCase()] });
            assert.equal(casing.totalAllocatedBytes, singleton.totalAllocatedBytes);
            assert.equal(casing.totalExclusiveBytes, singleton.totalExclusiveBytes);
        }
        await link(file, alias);
        const outside = await measureNativeDisk({ paths: [first] });
        assert.equal(outside.perPath[0].sharedBytes, singleton.totalAllocatedBytes);
        const shared = await measureNativeDisk({ paths: [scratch, first, second], unions: [
            { id: 'first', paths: [first] }, { id: 'both', paths: [first, second] },
            { id: 'aliases', paths: [file, alias] },
        ] });
        for (const union of shared.unions) {
            const paths = union.id === 'first' ? [first] : union.id === 'both' ? [first, second] : [file, alias];
            const independent = await measureNativeDisk({ paths });
            assert.equal(union.totalAllocatedBytes, independent.totalAllocatedBytes);
            assert.equal(union.totalExclusiveBytes, independent.totalExclusiveBytes);
            assert.equal(union.atLeast, false);
        }
    } finally {
        Object.defineProperty(process, 'execPath', executable);
        await rm(scratch, { recursive: true, force: true });
    }
});
