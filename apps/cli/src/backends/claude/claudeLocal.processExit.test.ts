import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createEnvKeyScope } from '@/testkit/env/envScope';

it.each([
    { kind: 'native', callbackFails: false },
    { kind: 'javascript', callbackFails: false },
    { kind: 'native', callbackFails: true },
] as const)('qualifies the real local $kind provider exit (callback fails: $callbackFails)', async ({ kind, callbackFails }) => {
    if (process.platform === 'win32' && kind === 'native') return; // Shebang executable is a POSIX OS fixture.
    vi.resetModules();
    const directory = mkdtempSync(join(tmpdir(), 'happier-claude-local-exit-'));
    const executable = join(directory, kind === 'javascript' ? 'provider.cjs' : 'provider');
    const env = createEnvKeyScope(['HAPPIER_CLAUDE_PATH', 'CLAUDE_CONFIG_DIR']);
    const stdinWasPaused = process.stdin.isPaused();
    writeFileSync(executable, `${kind === 'native' ? `#!${process.execPath}\n` : ''}process.exit(0);\n`, { mode: 0o700 });
    env.patch({ HAPPIER_CLAUDE_PATH: executable, CLAUDE_CONFIG_DIR: join(directory, 'config') });
    const exits: Array<Readonly<{ providerStopped: boolean }>> = [];
    try {
        const { claudeLocal } = await import('./claudeLocal');
        const failure = new Error('Exit observer failed');
        const launch = claudeLocal({ abort: new AbortController().signal, sessionId: null, path: directory,
            onSessionFound: () => {}, onProcessExit: result => { exits.push(result); if (callbackFails) throw failure; } });
        if (callbackFails) await expect(launch).rejects.toBe(failure);
        else await launch;
        expect(exits).toEqual([{ providerStopped: true }]);
    } finally {
        env.restore();
        if (stdinWasPaused) process.stdin.pause();
        rmSync(directory, { recursive: true, force: true });
    }
});
