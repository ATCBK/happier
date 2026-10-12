import { ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renameStoragePathNoReplace } from './renameStoragePath';

vi.mock('node:child_process', async (importActual) => ({
    ...await importActual<typeof import('node:child_process')>(),
    spawn: vi.fn(),
}));

const executableDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
let scratch: string;
let child: ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };

describe('storage rename native process boundary', () => {
    beforeAll(async () => {
        scratch = await mkdtemp(join(tmpdir(), 'happier-rename-adapter-'));
        const unpacked = join(scratch, 'tools', 'unpacked');
        await mkdir(unpacked, { recursive: true });
        await writeFile(join(unpacked, `happier-process-custody${process.platform === 'win32' ? '.exe' : ''}`), 'boundary fixture');
        Object.defineProperty(process, 'execPath', { ...executableDescriptor, value: join(scratch, 'happier') });
    });
    afterAll(async () => {
        Object.defineProperty(process, 'execPath', executableDescriptor);
        if (scratch) await rm(scratch, { recursive: true, force: true });
    });
    beforeEach(() => {
        // The OS child and its pipes are the genuine system boundary.
        child = Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        vi.spyOn(child, 'kill').mockReturnValue(true);
        vi.mocked(spawn).mockReturnValue(child);
    });
    it('holds cancellation until the native child actually closes', async () => {
        const controller = new AbortController();
        const done = renameStoragePathNoReplace('/source', '/target', controller.signal);
        let settled = false;
        void done.then(() => { settled = true; }, () => { settled = true; });
        controller.abort();
        await Promise.resolve();
        expect(settled).toBe(false);
        child.emit('close', null, 'SIGKILL');
        await expect(done).rejects.toMatchObject({ name: 'AbortError' });
    });
    it('keeps the native occupied-destination outcome typed', async () => {
        const done = renameStoragePathNoReplace('/source', '/target');
        child.stdout.write(JSON.stringify({ v: 1, status: 'failed', code: 'destination_occupied', message: 'occupied' }));
        child.emit('close', 0, null);
        await expect(done).rejects.toMatchObject({ code: 'destination_occupied' });
    });
    it('rejects malformed success rather than claiming a completed rename', async () => {
        const done = renameStoragePathNoReplace('/source', '/target');
        child.stdout.write(JSON.stringify({ v: 1, status: 'renamed', extraAuthority: true }));
        child.emit('close', 0, null);
        await expect(done).rejects.toMatchObject({ code: 'invalid_native_storage_output' });
    });
});
