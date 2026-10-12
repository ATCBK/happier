import { chmod, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { computePromptBundleDigestV1 } from '@happier-dev/protocol/prompts/library/promptLibraryDigests';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import { createDaemonControlApp } from './controlServer';

it('serves the real authenticated skill store and rejects unknown authority fields', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-control-'));
    const skillStore = createSkillStore({ happyHomeDir });
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine-one',
        stopSession: async () => ({ status: 'not_found' as const }),
        spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'secret', skillStore });
    const files = [{ path: 'SKILL.md', contentKind: 'utf8' as const, contentBase64: Buffer.from('Route-delivered skill').toString('base64') }];
    const payload = { ownerKey: 'session-one', items: [{ skillId: 'guide', name: 'guide', files,
        digest: computePromptBundleDigestV1({ v: 1, entries: files, createdAtMs: 0, updatedAtMs: 0 }) }], nativeDisables: [] };
    try {
        expect((await app.inject({ method: 'POST', url: '/skills/session-dir', payload })).statusCode).toBe(401);
        const accepted = await app.inject({ method: 'POST', url: '/skills/session-dir', headers: { 'x-happier-daemon-token': 'secret' }, payload });
        expect(accepted.statusCode).toBe(200);
        const delivery = accepted.json<{ pluginRoot: string; skillsRoot: string; failed: unknown[] }>();
        expect(delivery.failed).toEqual([]);
        expect(await readFile(join(delivery.skillsRoot, 'guide', 'SKILL.md'), 'utf8')).toBe('Route-delivered skill');
        const rejected = await app.inject({ method: 'POST', url: '/skills/session-dir', headers: { 'x-happier-daemon-token': 'secret' }, payload: { ...payload, force: true } });
        expect(rejected.statusCode).toBe(400);
        const traversal = await app.inject({ method: 'POST', url: '/skills/session-dir', headers: { 'x-happier-daemon-token': 'secret' }, payload: { ...payload, ownerKey: '../escape' } });
        expect(traversal.statusCode).toBe(400);
    } finally {
        await app.close();
        const writable = async (path: string): Promise<void> => {
            const info = await lstat(path); if (info.isSymbolicLink()) return;
            await chmod(path, info.isDirectory() ? 0o755 : 0o644);
            if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name));
        };
        await writable(happyHomeDir);
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});
