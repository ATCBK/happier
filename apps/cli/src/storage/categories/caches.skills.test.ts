import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { createStorageCategoryCatalog } from '../categoryCatalog';
import { createSkillStore } from '@/prompts/skills/store/skillStore';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('projects each skill cache entry from session manifest roots and fails closed when roots are unreadable', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-caches-')); roots.push(happyHomeDir);
    const liveDigest = 'a'.repeat(64); const unusedDigest = 'b'.repeat(64);
    const livePath = join(happyHomeDir, 'skills', 'cache', liveDigest);
    const unusedPath = join(happyHomeDir, 'skills', 'cache', unusedDigest);
    const sessionRoot = join(happyHomeDir, 'skills', 'sessions', 'session-one');
    await Promise.all([livePath, unusedPath, sessionRoot].map(path => mkdir(path, { recursive: true })));
    const manifestPath = join(sessionRoot, 'session.json');
    await writeFile(manifestPath, JSON.stringify({ items: [{ skillId: 'guide', name: 'guide', digest: `sha256:${liveDigest}` }] }));
    const store = createSkillStore({ happyHomeDir });
    const catalog = createStorageCategoryCatalog({ happyHomeDir, activeServerDir: join(happyHomeDir, 'servers', 'active'),
        readInUsePaths: () => ({ reliable: true, paths: [] }), readLiveSkillCachePaths: store.readLiveSkillCachePaths });
    const first = await catalog.discover();
    expect(first.find(item => item.path === livePath)).toMatchObject({ reason: { code: 'in_use' }, collectable: false });
    expect(first.find(item => item.path === unusedPath)).toMatchObject({ verdict: 'safe' });
    await writeFile(manifestPath, '{invalid');
    const uncertain = await catalog.discover();
    expect(uncertain.find(item => item.path === unusedPath)).toMatchObject({ verdict: 'check', collectable: false });
});
