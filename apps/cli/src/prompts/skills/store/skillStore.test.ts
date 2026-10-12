import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { createSkillStore, type SkillSessionDirItem } from './skillStore';

const scratch: string[] = [];
afterEach(async () => {
    for (const root of scratch.splice(0)) {
        // The fixture deliberately contains read-only immutable trees.
        const writable = async (path: string): Promise<void> => {
            const info = await lstat(path);
            if (info.isSymbolicLink()) return;
            await chmod(path, info.isDirectory() ? 0o755 : 0o644);
            if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
        };
        await writable(root);
        await rm(root, { recursive: true, force: true });
    }
});
function skill(name = 'guide', content = 'Use the guide'): SkillSessionDirItem {
    const files = [
        { path: 'SKILL.md', contentKind: 'utf8' as const, contentBase64: Buffer.from(content).toString('base64') },
        { path: 'scripts/run.sh', contentKind: 'utf8' as const, contentBase64: Buffer.from('#!/bin/sh\necho guide\n').toString('base64'), unixMode: 0o755 },
    ];
    return { skillId: `skill:${name}`, name, files, digest: computePromptBundleDigestV1({ v: 1, entries: files, createdAtMs: 0, updatedAtMs: 0 }) };
}
async function fixture(platform: NodeJS.Platform = process.platform) {
    const happyHomeDir = await realpath(await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-')));
    scratch.push(happyHomeDir);
    const store = createSkillStore({ happyHomeDir, platform });
    const ensure = (ownerKey: string, items = [skill()]) => store.ensureSkillSessionDir({ ownerKey, items, nativeDisables: [] });
    const cachePath = (item: SkillSessionDirItem) => join(happyHomeDir, 'skills', 'cache', item.digest.slice(7));
    return { happyHomeDir, store, ensure, cachePath };
}
describe('daemon skill store', () => {
    it('shares immutable cache entries, preserves executable bits and makes repeated ensure a no-op', async () => {
        const f = await fixture();
        const item = skill();
        const first = await f.ensure('session-one');
        const before = await stat(join(first.pluginRoot, 'session.json'));
        const again = await f.ensure('session-one');
        const other = await f.ensure('session-two');
        expect(again).toEqual(first);
        expect((await stat(join(first.pluginRoot, 'session.json'))).mtimeMs).toBe(before.mtimeMs);
        expect(await readdir(join(f.happyHomeDir, 'skills', 'cache'))).toEqual([item.digest.slice(7)]);
        expect(await readFile(join(other.skillsRoot, 'guide', 'scripts', 'run.sh'), 'utf8')).toContain('echo guide');
        if (process.platform !== 'win32') {
            expect((await stat(f.cachePath(item))).mode & 0o777).toBe(0o555);
            expect((await stat(join(f.cachePath(item), 'SKILL.md'))).mode & 0o777).toBe(0o444);
            expect((await stat(join(f.cachePath(item), 'scripts', 'run.sh'))).mode & 0o777).toBe(0o555);
            expect((await lstat(join(first.skillsRoot, 'guide'))).isSymbolicLink()).toBe(true);
        }
    });
    it('updates links and session manifest in the same folder and serializes concurrent writes', async () => {
        const f = await fixture();
        const initial = await f.ensure('session-one');
        const next = skill('guide', 'Updated guide');
        await Promise.all([f.ensure('session-one', [skill('other')]), f.ensure('session-one', [next])]);
        expect(await readdir(initial.skillsRoot)).toEqual(['guide']);
        expect(await readFile(join(initial.skillsRoot, 'guide', 'SKILL.md'), 'utf8')).toBe('Updated guide');
        expect(JSON.parse(await readFile(join(initial.pluginRoot, 'session.json'), 'utf8'))).toMatchObject({ items: [{ skillId: next.skillId, name: next.name, digest: next.digest }] });
    });
    it('uses read-only real copies on Windows', async () => {
        const f = await fixture('win32');
        const result = await f.ensure('session-one');
        expect((await lstat(join(result.skillsRoot, 'guide'))).isSymbolicLink()).toBe(false);
        expect(await readFile(join(result.skillsRoot, 'guide', 'SKILL.md'), 'utf8')).toBe('Use the guide');
        await f.store.releaseSkillSessionDirs('session-one');
        await expect(lstat(result.pluginRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('rejects tampered bodies before publication and isolates a staging filesystem failure per item', async () => {
        const f = await fixture();
        const invalid = { ...skill('invalid'), digest: `sha256:${'a'.repeat(64)}` };
        const broken = skill('broken');
        broken.files.push({ path: 'SKILL.md/child', contentKind: 'utf8', contentBase64: Buffer.from('cannot be written under a file').toString('base64') });
        const brokenItem = { ...broken, digest: computePromptBundleDigestV1({ v: 1, entries: broken.files, createdAtMs: 0, updatedAtMs: 0 }) };
        const result = await f.ensure('session-one', [invalid, brokenItem, skill('valid')]);
        expect(result.failed).toMatchObject([{ skillId: invalid.skillId, reason: 'materialize_failed', detail: 'digest_mismatch' }, { skillId: broken.skillId, reason: 'materialize_failed' }]);
        expect(await readdir(result.skillsRoot)).toEqual(['valid']);
        expect(await readdir(join(f.happyHomeDir, 'skills', 'cache'))).toEqual([skill('valid').digest.slice(7)]);
    });
    it('roots GC in session and Run manifests plus a successful library inventory', async () => {
        const f = await fixture();
        const session = skill('session'); const run = skill('run'); const library = skill('library'); const unused = skill('unused');
        await f.ensure('session-one', [session]);
        await f.ensure('session-one/runs/run-one', [run]);
        await f.ensure('retired', [library, unused]);
        await f.store.releaseSkillSessionDirs('retired');
        const staging = join(f.happyHomeDir, 'skills', 'cache', '.staging-interrupted');
        await mkdir(staging);
        await writeFile(join(staging, 'partial'), 'partial');
        await f.store.collectSkillCache({ libraryDigests: null });
        expect(await lstat(f.cachePath(unused))).toBeDefined();
        expect(await lstat(staging)).toBeDefined();
        await f.store.collectSkillCache({ libraryDigests: [library.digest] });
        expect(await readdir(join(f.happyHomeDir, 'skills', 'cache'))).toEqual(expect.arrayContaining([session.digest.slice(7), run.digest.slice(7), library.digest.slice(7)]));
        await expect(lstat(f.cachePath(unused))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(lstat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
        const roots = await f.store.readLiveSkillCachePaths();
        expect(roots.reliable).toBe(true);
        expect(roots.paths).toEqual(new Set([f.cachePath(session), f.cachePath(run)]));
    });
    it('retains everything when a session manifest or live inventory is unreadable', async () => {
        const f = await fixture();
        const session = await f.ensure('session-one');
        await writeFile(join(session.pluginRoot, 'session.json'), '{bad');
        expect((await f.store.readLiveSkillCachePaths()).reliable).toBe(false);
        await f.store.collectSkillCache({ libraryDigests: [] });
        expect(await lstat(f.cachePath(skill()))).toBeDefined();
        await f.store.reconcileSkillSessionDirs({ liveSessionIds: null, libraryDigests: [] });
        expect(await lstat(session.pluginRoot)).toBeDefined();
    });
    it('sweeps stale session folders after re-adoption, including their Runs, and keeps tracked sessions', async () => {
        const f = await fixture();
        const live = await f.ensure('live'); const stale = await f.ensure('stale');
        await f.ensure('stale/runs/run-one', [skill('run')]);
        await f.store.reconcileSkillSessionDirs({ liveSessionIds: ['live'], libraryDigests: [] });
        expect(await lstat(live.pluginRoot)).toBeDefined();
        await expect(lstat(stale.pluginRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
