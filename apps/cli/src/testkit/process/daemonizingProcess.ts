import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, vi } from 'vitest';

import { captureProcessTree } from '@/processes/terminate/terminateProcessTree';
import { waitForProcessExit } from './spawn';

/** Real OS fixture: a finite launcher creates an independent native daemon. */
export function createDaemonizingProcessFixture(directory: string) {
    const readyPath = join(directory, 'ready.json');
    const releasePath = join(directory, 'exit');
    let descendantPid: number | undefined;
    const args = ['-e', `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: 'ignore', detached: process.platform !== 'win32',
        });
        child.unref();
        process.stdout.write('ready', () => fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ rootPid: process.pid, descendantPid: child.pid })));
        setInterval(() => {
            if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(Number(fs.readFileSync(${JSON.stringify(releasePath)}, 'utf8')));
        }, 10);
    `];
    return {
        args,
        async ready(options: Readonly<{ launch?: Promise<unknown>; timeoutMs: number }>) {
            let rootPid = 0;
            let launchFailure: { error: unknown } | undefined;
            void options.launch?.catch(error => { launchFailure = { error }; });
            await vi.waitUntil(async () => {
                if (launchFailure) throw launchFailure.error;
                try {
                    const value = JSON.parse(await readFile(readyPath, 'utf8')) as { rootPid: number; descendantPid: number };
                    rootPid = value.rootPid;
                    descendantPid = value.descendantPid;
                    return true;
                } catch (error) {
                    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
                    throw error;
                }
            }, { timeout: options.timeoutMs });
            expect(descendantPid).toBeGreaterThan(0);
            // Keep the launcher alive through a real native capture. The supervisor
            // also captures at its first-output boundary, before this release.
            const captured = await captureProcessTree({ pid: rootPid });
            expect(captured.status).toBe('ok');
            if (captured.status === 'ok') expect(captured.capturedTargets.some(row => row.pid === descendantPid)).toBe(true);
            return descendantPid!;
        },
        release: (exitCode = 0) => writeFile(releasePath, String(exitCode)),
        async cleanup() {
            if (!descendantPid) {
                try { descendantPid = JSON.parse(await readFile(readyPath, 'utf8')).descendantPid; } catch { /* no launch */ }
            }
            if (descendantPid) {
                try { process.kill(descendantPid, 'SIGKILL'); } catch { /* already terminated */ }
                await waitForProcessExit(descendantPid);
            }
        },
    };
}
