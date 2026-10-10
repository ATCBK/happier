import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { probeProcessGroupLiveness } from '@happier-dev/cli-common/process';
import { createFloxServiceActivationArgs } from './floxServiceActivation';

describe('installed Flox foreground service activation', () => {
    it.skipIf(!process.env.FX19_FLOX_PATH)('owns only the selected service until native stop, failure or cancellation', async () => {
        const flox = process.env.FX19_FLOX_PATH!;
        const root = await mkdtemp(join(tmpdir(), 'happier-fx19-flox-'));
        const children: ChildProcess[] = [];
        const run = async (args: readonly string[]) => {
            const child = spawn(flox, [...args], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = ''; let stderr = '';
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
            return { exitCode, stdout, stderr };
        };
        const status = async () => {
            const result = await run(['services', 'status', '--dir', root, '--json']);
            expect(result.exitCode, result.stderr).toBe(0);
            return JSON.parse(result.stdout) as Array<{ name: string; status: string; pid: number | null }>;
        };
        const start = () => {
            const child = spawn(flox, [...createFloxServiceActivationArgs({ command: flox, prefixArgs: [], root, target: 'worker', observationIntervalMs: 5_000 })],
                { cwd: root, env: { ...process.env, FLOX_SHELL: '/bin/bash' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
            children.push(child);
            let output = '';
            child.stdout.on('data', chunk => { output += chunk; });
            child.stderr.on('data', chunk => { output += chunk; });
            const settled = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
            return { child, settled, output: () => output };
        };
        try {
            expect((await run(['init', '--bare', '--no-auto-setup', '--dir', root, '--name', 'fx19-test'])).exitCode).toBe(0);
            const manifest = 'version = 1\n[services.worker]\ncommand = "echo fx19-output; echo fx19-error >&2; while test ! -f fail-service; do sleep 1; done; exit 23"\n[services.other]\ncommand = "echo fx19-unselected; while true; do sleep 1; done"\n';
            await writeFile(join(root, '.flox/env/manifest.toml'), manifest);
            const first = start();
            await expect.poll(async () => (await status()).find(service => service.name === 'worker')?.status,
                { timeout: 30_000, message: 'Selected service must run from a cold environment' }).toBe('Running');
            expect(first.child.exitCode, first.output()).toBeNull();
            expect((await status()).find(service => service.name === 'other')?.status).not.toBe('Running');
            // A second activation must not borrow a service already owned elsewhere.
            const incumbent = start();
            await expect.poll(() => incumbent.child.exitCode, { timeout: 30_000 }).toBe(1);
            expect(await incumbent.settled).toBe(1);
            expect((await status()).find(service => service.name === 'worker')?.status).toBe('Running');
            expect(first.child.exitCode, first.output()).toBeNull();
            const logs = await run(['services', 'logs', '--dir', root, 'worker']);
            expect(logs.exitCode).toBe(0);
            expect(logs.stdout).toContain('fx19-output');
            expect(logs.stdout).toContain('fx19-error');
            expect((await run(['services', 'stop', '--dir', root, 'worker'])).exitCode).toBe(0);
            await expect.poll(() => first.child.exitCode, { timeout: 30_000, message: 'Native stop must end the activation' }).toBe(0);
            expect(await first.settled).toBe(0);
            await expect.poll(() => probeProcessGroupLiveness(first.child.pid!), { timeout: 30_000 }).toBe('absent');
            await expect.poll(async () => (await status()).every(service => service.pid === null), { timeout: 30_000 }).toBe(true);
            const failure = start();
            await expect.poll(async () => (await status()).find(service => service.name === 'worker')?.status, { timeout: 30_000 }).toBe('Running');
            await writeFile(join(root, 'fail-service'), 'fail');
            await expect.poll(() => failure.child.exitCode, { timeout: 30_000, message: 'Native failure must end the activation with its exit code' }).toBe(23);
            expect(await failure.settled).toBe(23);
            await expect.poll(() => probeProcessGroupLiveness(failure.child.pid!), { timeout: 30_000 }).toBe('absent');
            await rm(join(root, 'fail-service'));
            await expect.poll(async () => (await status()).every(service => service.pid === null), { timeout: 30_000 }).toBe(true);
            const cancellation = start();
            await expect.poll(async () => (await status()).find(service => service.name === 'worker')?.status, { timeout: 30_000 }).toBe('Running');
            process.kill(-cancellation.child.pid!, 'SIGTERM');
            await cancellation.settled;
            await expect.poll(() => probeProcessGroupLiveness(cancellation.child.pid!), { timeout: 30_000 }).toBe('absent');
            await expect.poll(async () => (await status()).every(service => service.pid === null), { timeout: 30_000 }).toBe(true);
        } finally {
            await run(['services', 'stop', '--dir', root]);
            for (const child of children) {
                if (child.pid && probeProcessGroupLiveness(child.pid) !== 'absent') { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
            }
            await delay(1_000);
            for (const child of children) {
                if (child.pid && probeProcessGroupLiveness(child.pid) !== 'absent') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
            }
            await expect.poll(async () => (await status()).every(service => service.pid === null), { timeout: 30_000 }).toBe(true);
            await rm(root, { recursive: true, force: true });
        }
    }, 120_000);
});
