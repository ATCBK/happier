import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readStoragePathIdentity } from './trash/removeStoragePath';
import { classifyPath } from './protection/protectedPaths';

it.skipIf(process.platform === 'win32')('reads and protects the actual POSIX byte path rather than its UTF replacement spelling', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-storage-byte-path-')));
    const bytes = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff]), Buffer.from('-private')]);
    const path = `bytes:${bytes.toString('base64')}`;
    const twin = bytes.toString('utf8');
    try {
        await mkdir(bytes); await mkdir(twin);
        await writeFile(Buffer.concat([bytes, Buffer.from('/exact')]), 'exact');
        const identity = await readStoragePathIdentity(path);
        expect(identity.ino).toBe(String((await lstat(bytes, { bigint: true })).ino));
        expect(identity.ino).not.toBe(String((await lstat(twin, { bigint: true })).ino));
        const child = `bytes:${Buffer.concat([bytes, Buffer.from('/exact')]).toString('base64')}`;
        expect(await classifyPath(child, { homeDir: root, userProtectedFolders: [path] }))
            .toMatchObject({ tier: 'keep', reason: { code: 'user_protected' } });
        expect((await classifyPath(twin, { homeDir: root, userProtectedFolders: [path] })).tier).not.toBe('keep');
        const hidden = Buffer.concat([Buffer.from(`${root}/.`), Buffer.from([0xff]), Buffer.from('-state')]);
        await mkdir(hidden);
        expect(await classifyPath(`bytes:${hidden.toString('base64')}`, { homeDir: root }))
            .toMatchObject({ tier: 'caution', reason: { code: 'not_rebuildable', detail: { hiddenFolder: true } } });
    } finally { await rm(root, { recursive: true, force: true }); }
});
