import { mkdir, mkdtemp, readFile, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createProcessCustodyFixture } from '@/testkit/processCustodyFixture';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createHappierTempDir, getHappierTempDirOwnerPath } from '@happier-dev/cli-common/tempDirs';
import { createStorageCategoryCatalog } from './categoryCatalog';
import { createStorageFilesystemAdapter } from './trash/filesystemAdapter';
import { readStoragePathIdentity } from './trash/removeStoragePath';
import { filesystemAdapterForEntry } from './categories/filesystemAdapters';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { deriveVoiceModelPackDirectoryKeyV1 } from '@happier-dev/voice-modelpacks';
import { createStorageWorktreeOperations } from './worktrees/storageWorktreeOperations';
import { createScmBackendRegistry } from '@/scm/registry';

const roots: string[] = [];
function retiredOwnerData(value: JsonValue): JsonValue {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object owner data');
    return { ...value, retired: true };
}
let disposeNative: (() => Promise<void>) | undefined;
beforeAll(async () => { disposeNative = await createProcessCustodyFixture(); });
afterAll(async () => { await disposeNative?.(); });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'storage-adapters-')); roots.push(happyHomeDir);
    const activeServerDir = join(happyHomeDir, 'server');
    await mkdir(activeServerDir);
    return { happyHomeDir, activeServerDir, tempRoot: join(happyHomeDir, 'absent-tmp') };
}
it('drops retired stored owner fields while retaining filesystem containment validation', () => {
    const sourcePath = join(tmpdir(), 'storage-owner', 'entry');
    const allowedRoot = join(tmpdir(), 'storage-owner');
    expect(filesystemAdapterForEntry({ kind: 'filesystem', sourcePath, allowedRoot, retired: true }).ownerData)
        .toEqual({ kind: 'filesystem', sourcePath, allowedRoot });
    expect(() => filesystemAdapterForEntry({ kind: 'filesystem', sourcePath, allowedRoot: sourcePath, retired: true }))
        .toThrow();
});
it('drops retired Worktree owner fields without changing recovery identity or accepting malformed known fields', async () => {
    const f = await fixture();
    const data = { v: 1, repositoryRoot: join(f.happyHomeDir, 'repository'),
        worktreePath: join(f.happyHomeDir, 'repository', '.happier', 'worktrees', 'topic'), retentionSupported: true };
    const catalog = createStorageCategoryCatalog({ ...f, worktreeOperations: createStorageWorktreeOperations({
        happyHomeDir: f.happyHomeDir, registry: createScmBackendRegistry([]),
    }) });
    expect((await catalog.adapterForEntry('worktrees', { ...data, retired: true })).ownerData).toEqual(data);
    await expect(catalog.adapterForEntry('worktrees', { ...data, repositoryRoot: '', retired: true }))
        .rejects.toMatchObject({ code: 'owner_data_invalid' });
});
it('drops retired Model Pack owner fields without changing artifact identity or accepting a different key', async () => {
    const f = await fixture();
    const identity = { pluginId: 'acme.speech', packId: 'english' };
    const metadata = { schemaVersion: 1, identity, directoryKey: deriveVoiceModelPackDirectoryKeyV1(identity),
        pluginVersion: '2.0.0', artifactBinding: { kind: 'sourceIntegrity', integrity: `sha256:${'b'.repeat(64)}` },
        packVersion: '1.0.0', manifestDigest: 'c'.repeat(64), verifiedAtMs: 100 };
    const catalog = createStorageCategoryCatalog(f);
    const key = 'acme.speech/english';
    const stored = { key, metadata: { ...metadata, retired: true, identity: { ...identity, retired: true } }, retired: true };
    expect((await catalog.adapterForEntry('modelPacks', stored)).ownerData).toEqual({ key, metadata });
    await expect(catalog.adapterForEntry('modelPacks', { ...stored, key: 'acme.speech/different' }))
        .rejects.toMatchObject({ code: 'owner_data_invalid' });
});
it('contracts only validated creator markers when native storage retirement or deletion finishes', async () => {
    const f = await fixture();
    const source = createHappierTempDir({ purpose: 'storage-marker', root: f.happyHomeDir });
    const sibling = createHappierTempDir({ purpose: 'storage-marker', root: f.happyHomeDir });
    const siblingMarker = getHappierTempDirOwnerPath(sibling);
    const siblingContents = await readFile(siblingMarker, 'utf8');
    await writeFile(join(source, 'bytes'), 'temporary-bytes');
    const adapter = createStorageFilesystemAdapter({ sourcePath: source, allowedRoot: f.happyHomeDir });
    const payloadPath = join(f.happyHomeDir, 'payload');
    const markerContents = await readFile(getHappierTempDirOwnerPath(source), 'utf8');
    await adapter.retire({ payloadPath });
    expect(await readFile(join(payloadPath, 'bytes'), 'utf8')).toBe('temporary-bytes');
    await expect(readFile(getHappierTempDirOwnerPath(source))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(siblingMarker, 'utf8')).toBe(siblingContents);
    // A new adapter after daemon reload must restore the original ownership witness,
    // not fabricate one for the restoring process.
    const restarted = createStorageFilesystemAdapter({ sourcePath: source, allowedRoot: f.happyHomeDir });
    await restarted.reinstate({ payloadPath, restorePath: source });
    expect(await readFile(getHappierTempDirOwnerPath(source), 'utf8')).toBe(markerContents);
    expect(await readFile(join(source, 'bytes'), 'utf8')).toBe('temporary-bytes');
    await expect(readFile(getHappierTempDirOwnerPath(payloadPath))).rejects.toMatchObject({ code: 'ENOENT' });
    await createStorageFilesystemAdapter({ sourcePath: sibling, allowedRoot: f.happyHomeDir }).discard();
    await expect(readFile(siblingMarker)).rejects.toMatchObject({ code: 'ENOENT' });

    const malformed = createHappierTempDir({ purpose: 'malformed', root: f.happyHomeDir });
    await writeFile(getHappierTempDirOwnerPath(malformed), '{');
    await createStorageFilesystemAdapter({ sourcePath: malformed, allowedRoot: f.happyHomeDir }).discard();
    expect(await readFile(getHappierTempDirOwnerPath(malformed), 'utf8')).toBe('{');
    const unrelated = join(f.happyHomeDir, 'ordinary');
    await mkdir(unrelated);
    await writeFile(getHappierTempDirOwnerPath(unrelated), siblingContents);
    await createStorageFilesystemAdapter({ sourcePath: unrelated, allowedRoot: f.happyHomeDir }).discard();
    expect(await readFile(getHappierTempDirOwnerPath(unrelated), 'utf8')).toBe(siblingContents);
    const mismatched = createHappierTempDir({ purpose: 'different-purpose', root: f.happyHomeDir });
    await writeFile(getHappierTempDirOwnerPath(mismatched), siblingContents);
    await createStorageFilesystemAdapter({ sourcePath: mismatched, allowedRoot: f.happyHomeDir }).discard();
    expect(await readFile(getHappierTempDirOwnerPath(mismatched), 'utf8')).toBe(siblingContents);
    if (process.platform !== 'win32') {
        const linked = createHappierTempDir({ purpose: 'storage-marker', root: f.happyHomeDir });
        const linkedMarker = getHappierTempDirOwnerPath(linked);
        const target = join(f.happyHomeDir, 'unrelated-marker.json');
        await writeFile(target, siblingContents); await rm(linkedMarker); await symlink(target, linkedMarker);
        await createStorageFilesystemAdapter({ sourcePath: linked, allowedRoot: f.happyHomeDir }).discard();
        expect(await readFile(linkedMarker, 'utf8')).toBe(siblingContents);
        expect(await readFile(target, 'utf8')).toBe(siblingContents);
    }
});
it('preserves a valid replacement temp marker and an unaccepted retirement marker', async () => {
    const f = await fixture();
    const source = createHappierTempDir({ purpose: 'marker-race', root: f.happyHomeDir });
    const marker = getHappierTempDirOwnerPath(source);
    const original = await readFile(marker, 'utf8');
    const adapter = createStorageFilesystemAdapter({ sourcePath: source, allowedRoot: f.happyHomeDir });
    const denied = Object.assign(new Error('authority changed'), { code: 'unauthorized' });
    const payloadPath = join(f.happyHomeDir, 'payload');
    await expect(adapter.retire({ payloadPath, beforeEffect: async () => { throw denied; } })).rejects.toBe(denied);
    expect(await readFile(marker, 'utf8')).toBe(original);
    await adapter.retire({ payloadPath, beforeEffect: async () => {
        await rename(marker, `${marker}.previous`);
        await writeFile(marker, original);
    } });
    expect(await readFile(marker, 'utf8')).toBe(original);
    expect(await readFile(`${marker}.previous`, 'utf8')).toBe(original);
});
it('recovers interrupted temp marker moves and cleans ownership after Put back beside it', async () => {
    const f = await fixture();
    const source = createHappierTempDir({ purpose: 'marker-recovery', root: f.happyHomeDir });
    const marker = getHappierTempDirOwnerPath(source);
    const original = await readFile(marker, 'utf8');
    const payloadPath = join(f.happyHomeDir, 'payload');
    const adapter = createStorageFilesystemAdapter({ sourcePath: source, allowedRoot: f.happyHomeDir });
    // Model interruption after the payload rename, before its sibling follows.
    await rename(source, payloadPath); await adapter.retire({ payloadPath });
    await rename(payloadPath, source); await adapter.reinstate({ payloadPath, restorePath: source });
    expect(await readFile(marker, 'utf8')).toBe(original);
    await adapter.retire({ payloadPath });
    const beside = `${source} (restored)`;
    await adapter.reinstate({ payloadPath, restorePath: beside });
    expect(await readFile(getHappierTempDirOwnerPath(beside), 'utf8')).toBe(original);
    await createStorageFilesystemAdapter({ sourcePath: beside, allowedRoot: f.happyHomeDir }).discard();
    await expect(readFile(getHappierTempDirOwnerPath(beside))).rejects.toMatchObject({ code: 'ENOENT' });
});
it.skipIf(process.platform === 'win32')('moves, restores and deletes the exact native byte name without touching its replacement twin', async () => {
    const f = await fixture();
    const pathBytes = Buffer.concat([Buffer.from(`${f.happyHomeDir}/`), Buffer.from([0xff]), Buffer.from('-bytes')]);
    const sourcePath = `bytes:${pathBytes.toString('base64')}`;
    const replacementPath = pathBytes.toString('utf8');
    await writeFile(pathBytes, 'exact-bytes'); await writeFile(replacementPath, 'replacement-twin');
    const identity = await readStoragePathIdentity(sourcePath);
    expect(identity).not.toEqual(await readStoragePathIdentity(replacementPath));
    const adapter = createStorageFilesystemAdapter({ sourcePath, allowedRoot: f.happyHomeDir });
    const payloadPath = join(f.happyHomeDir, 'payload');
    await adapter.retire({ payloadPath });
    expect(await readFile(payloadPath, 'utf8')).toBe('exact-bytes');
    expect(await readFile(replacementPath, 'utf8')).toBe('replacement-twin');
    await adapter.reinstate({ payloadPath, restorePath: sourcePath });
    expect(await readFile(pathBytes, 'utf8')).toBe('exact-bytes');
    await adapter.discard({});
    await expect(readFile(pathBytes)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(replacementPath, 'utf8')).toBe('replacement-twin');
});
it('binds a discovered managed allocation to its owner and restores after catalog restart', async () => {
    const f = await fixture();
    const owner = createManagedSessionDirectories({ activeServerDir: f.activeServerDir });
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'catalog-trash' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
    await writeFile(join(allocation.directory, 'data'), 'owned-bytes');
    const deps = { ...f, managedSessionDirectories: owner,
        readTrackedSessions: () => [{ sessionId: 'session', cwd: allocation.directory, running: false, stoppedAt: 1 }] };
    const catalog = createStorageCategoryCatalog(deps);
    const item = (await catalog.discover()).find(item => item.path === allocation.directory)!;
    const bound = await catalog.resolveAdapter(item);
    expect(bound.sessionId).toBe('session');
    const payloadPath = join(f.happyHomeDir, 'payload');
    const denied = Object.assign(new Error('approval changed'), { code: 'changed_since_review' });
    await expect(bound.retire({ payloadPath, beforeEffect: async () => { throw denied; } })).rejects.toBe(denied);
    expect(await readFile(join(allocation.directory, 'data'), 'utf8')).toBe('owned-bytes');
    expect(await owner.listRecords()).toHaveLength(1);
    await bound.retire({ payloadPath });
    expect((await catalog.discover()).some(item => item.path === allocation.directory)).toBe(false);
    const restored = await createStorageCategoryCatalog(deps).adapterForEntry('sessionFolders', retiredOwnerData(bound.ownerData));
    expect(restored.sessionId).toBe('session');
    await expect(restored.reinstate({ payloadPath, restorePath: allocation.directory,
        beforeEffect: async () => { await mkdir(allocation.directory); } })).rejects.toMatchObject({ code: 'destination_occupied' });
    expect(await readFile(join(payloadPath, 'data'), 'utf8')).toBe('owned-bytes');
    await rmdir(allocation.directory);
    await restored.reinstate({ payloadPath, restorePath: allocation.directory });
    expect(await owner.resolveForSession({ sessionId: 'session', path: allocation.directory })).toMatchObject({ ok: true });
    expect(await readFile(join(allocation.directory, 'data'), 'utf8')).toBe('owned-bytes');
    await expect(restored.discard({ beforeEffect: async () => { throw denied; } })).rejects.toBe(denied);
    expect((await owner.listRecords())[0]?.pendingRemoval).toBeUndefined();
    expect(await owner.resolveForSession({ sessionId: 'session', path: allocation.directory })).toMatchObject({ ok: true });
    await expect(catalog.resolveAdapter({ ...item, path: join(f.happyHomeDir, 'forged') })).rejects.toMatchObject({ code: 'owner_unavailable' });
    await expect(catalog.adapterForEntry('sessionFolders', { kind: 'allocation', allocationId: '',
        path: '/forged' })).rejects.toThrow();
});
it('binds generic cleanup only from a catalog item and round-trips its bytes through the shared filesystem adapter', async () => {
    const f = await fixture();
    const cache = join(f.happyHomeDir, 'cache', 'pnpm'); await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'bytes'), 'cache-data');
    const catalog = createStorageCategoryCatalog(f);
    const item = (await catalog.discover()).find(item => item.path === cache)!;
    const bound = await catalog.resolveAdapter(item);
    const payloadPath = join(f.happyHomeDir, 'payload');
    await bound.retire({ payloadPath });
    const restarted = await createStorageCategoryCatalog(f).adapterForEntry('caches', bound.ownerData);
    await restarted.reinstate({ payloadPath, restorePath: cache });
    expect(await readFile(join(cache, 'bytes'), 'utf8')).toBe('cache-data');
    await restarted.discard({});
    await expect(readFile(join(cache, 'bytes'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('finishes an interrupted allocation Empty and allows receipt retry without granting restoration authority', async () => {
    const f = await fixture();
    const owner = createManagedSessionDirectories({ activeServerDir: f.activeServerDir });
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'catalog-empty-crash' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
    const catalog = createStorageCategoryCatalog({ ...f, managedSessionDirectories: owner });
    const item = (await catalog.discover()).find(item => item.path === allocation.directory)!;
    const bound = await catalog.resolveAdapter(item);
    const payloadPath = join(f.happyHomeDir, 'payload');
    await bound.retire({ payloadPath });
    await rm(payloadPath, { recursive: true });
    const denied = Object.assign(new Error('authority changed'), { code: 'unauthorized' });
    await expect(bound.discard({ payloadPath, beforeEffect: async () => { throw denied; } })).rejects.toBe(denied);
    expect(await owner.listRecords({ includeTrashed: true })).toHaveLength(1);
    await bound.discard({ payloadPath });
    expect(await owner.listRecords({ includeTrashed: true })).toHaveLength(0);
    const restarted = await catalog.adapterForEntry('sessionFolders', retiredOwnerData(bound.ownerData));
    expect(restarted.sessionId).toBeUndefined();
    expect(restarted.restorable).toBe(false);
    await restarted.discard({ payloadPath });
    await expect(restarted.reinstate({ payloadPath, restorePath: allocation.directory })).rejects.toMatchObject({ code: 'owner_unavailable' });
    await mkdir(payloadPath);
    await writeFile(join(payloadPath, 'unowned'), 'preserve');
    await expect(restarted.discard({ payloadPath })).rejects.toMatchObject({ code: 'owner_unavailable' });
    expect(await readFile(join(payloadPath, 'unowned'), 'utf8')).toBe('preserve');
});
it('finishes an interrupted allocation retirement without moving retained bytes again', async () => {
    const f = await fixture();
    const owner = createManagedSessionDirectories({ activeServerDir: f.activeServerDir });
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: 'catalog-retire-crash' });
    await owner.bind({ allocationId: allocation.allocationId, sessionId: 'session' });
    const catalog = createStorageCategoryCatalog({ ...f, managedSessionDirectories: owner });
    const item = (await catalog.discover()).find(item => item.path === allocation.directory)!;
    const bound = await catalog.resolveAdapter(item);
    const payloadPath = join(f.happyHomeDir, 'payload');
    await rename(allocation.directory, payloadPath);
    const denied = Object.assign(new Error('authority changed'), { code: 'unauthorized' });
    await expect(bound.retire({ payloadPath, beforeEffect: async () => { throw denied; } })).rejects.toBe(denied);
    expect((await owner.listRecords())[0]?.inTrash).toBeUndefined();
    await bound.retire({ payloadPath });
    await bound.retire({ payloadPath });
    expect(await owner.listRecords()).toHaveLength(0);
    expect((await owner.listRecords({ includeTrashed: true }))[0]?.inTrash).toEqual({ payloadPath });
});
it('refuses recording Trash with a typed reason and never claims unsupported restoration', async () => {
    const f = await fixture();
    const path = join(f.happyHomeDir, 'draft.webm'); await writeFile(path, 'draft-video');
    const catalog = createStorageCategoryCatalog({ ...f,
        readRecordings: async () => [{ recordingId: 'recording', path, active: false }] });
    const item = (await catalog.discover()).find(item => item.path === path)!;
    const bound = await catalog.resolveAdapter(item);
    const adapter = await catalog.adapterForEntry('recordings', retiredOwnerData(bound.ownerData));
    expect(adapter.restorable).toBe(false);
    await expect(adapter.retire({ payloadPath: join(f.happyHomeDir, 'payload') })).rejects.toMatchObject({ code: 'restore_unsupported' });
    await expect(adapter.reinstate({ payloadPath: path, restorePath: path })).rejects.toMatchObject({ code: 'restore_unsupported' });
    expect(await readFile(path, 'utf8')).toBe('draft-video');
});
it('discovers every current local Trash root supplied by its canonical owner', async () => {
    const f = await fixture();
    const otherTrash = join(f.happyHomeDir, 'other-volume-trash');
    const defaultTrash = join(f.happyHomeDir, 'trash');
    await Promise.all([otherTrash, defaultTrash].map(path => mkdir(path)));
    const catalog = createStorageCategoryCatalog({ ...f, trashRoots: () => [defaultTrash, otherTrash] });
    expect((await catalog.discover()).filter(item => item.categoryId === 'trash').map(item => item.path)).toEqual([defaultTrash, otherTrash]);
});
it('retains the canonical session binding of upload bytes in private owner data', async () => {
    const f = await fixture();
    const workspace = join(f.happyHomeDir, 'workspace');
    const upload = join(workspace, '.happier', 'uploads', 'artifacts', 'session-upload');
    await mkdir(upload, { recursive: true });
    const catalog = createStorageCategoryCatalog({ ...f,
        readTrackedSessions: () => [{ sessionId: 'session-upload', cwd: workspace, running: false, stoppedAt: 1 }] });
    const item = (await catalog.discover()).find(item => item.path === upload)!;
    const bound = await catalog.resolveAdapter(item);
    expect(bound.sessionId).toBe('session-upload');
    expect((await catalog.adapterForEntry('sessionFolders', retiredOwnerData(bound.ownerData))).sessionId).toBe('session-upload');
});
