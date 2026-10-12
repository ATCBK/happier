import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSkillStore } from '@/prompts/skills/store/skillStore';
import type { TrackedSession } from '../types';
import { createOnChildExited } from './onChildExited';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(replacement: boolean) {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-impl-p3b-store-exit-')); roots.push(happyHomeDir);
    const sessionId = 'PID-424242'; const pid = 424242;
    const pluginRoot = join(happyHomeDir, 'skills', 'sessions', sessionId);
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, 'session.json'), JSON.stringify({ items: [] }));
    const tracked: TrackedSession = { pid, happySessionId: sessionId, startedBy: 'terminal' };
    const sessions = new Map([[pid, tracked]]);
    if (replacement) sessions.set(process.pid, { pid: process.pid, happySessionId: sessionId, startedBy: 'terminal' });
    const store = createSkillStore({ happyHomeDir, readLibraryDigests: async () => [] });
    const exited = createOnChildExited({ pidToTrackedSession: sessions, spawnResourceCleanupByPid: new Map(),
        sessionAttachCleanupByPid: new Map(), getApiMachineForSessions: () => null,
        // Persistence is an OS boundary; this fixture never writes a real Session marker.
        removeSessionMarkerFn: async () => {}, skillStore: store });
    await exited(pid, { reason: 'process-exited', code: 0, signal: null });
    return { pluginRoot, sessions };
}
it('releases the skill folder when the runner exits', async () => {
    const f = await fixture(false);
    await expect(lstat(f.pluginRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('retains the skill folder for a live replacement runner of the same Session', async () => {
    const f = await fixture(true);
    expect(await lstat(f.pluginRoot)).toBeDefined();
    expect(f.sessions.has(process.pid)).toBe(true);
});
