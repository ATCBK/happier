import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentLaunchObserver, type AgentLaunchObserverBoundaries } from './observeAgentLaunch.js';

describe('Agent launch boundary observer', () => {
    it('observes bytes, removed files and symlink identity without following native symlinks', () => {
        const home = mkdtempSync(join(tmpdir(), 'happier-launch-observer-'));
        try {
            mkdirSync(join(home, '.claude'));
            const changed = join(home, '.claude', 'settings.json');
            const removed = join(home, '.claude', 'removed');
            writeFileSync(changed, '{}');
            writeFileSync(removed, 'existing');
            if (process.platform !== 'win32') symlinkSync(home, join(home, '.claude', 'cycle'));
            const observer = createAgentLaunchObserver({ home });
            const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
            boundaries.recordLaunch({ argv: ['--plugin-dir', '/session/skills'], env: { HOME: home, ABSENT: undefined } });
            boundaries.recordAppServerRequest('skills/extraRoots/set', { extraRoots: ['/session/skills'] });
            boundaries.recordAcpSessionNew({ cwd: home });
            boundaries.recordRuntimeEvent({ kind: 'commands-changed' });
            writeFileSync(changed, '{"changed":true}');
            unlinkSync(removed);
            expect(observer.observeLaunch()).toEqual({
                argv: ['--plugin-dir', '/session/skills'], env: { HOME: home },
                acpSessionNew: { cwd: home },
                appServerRequests: [{ method: 'skills/extraRoots/set', params: { extraRoots: ['/session/skills'] } }],
                runtimeEvents: [{ kind: 'commands-changed' }], filesWritten: [removed, changed].sort(),
            });
            boundaries.reset();
            expect(observer.observeLaunch().filesWritten).toEqual([]);
            expect(observer.observeLaunch().appServerRequests).toEqual([]);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
});
