import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prefilterExternalSessionContentPaths } from '../../../../../packages/plugin-sdk/src/sessions/fileStores/contentSearch';
import { searchCodexExternalTranscript } from '../../../../../packages/plugins/codex/src/agent/surfaces/sessions/external/transcriptSource';
import { run } from './index';

const processProbe = vi.hoisted(() => ({ observe: undefined as ((child: ChildProcess) => void) | undefined }));
// Observe the native process boundary while forwarding every real spawn.
vi.mock('child_process', async original => {
    const actual = await original<typeof import('node:child_process')>();
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
        const child = actual.spawn(...args);
        processProbe.observe?.(child);
        return child;
    } };
});

describe('ripgrep search payload transport', () => {
    it.skipIf(process.platform !== 'linux')('cancels a real multi-batch search without later or orphan children and closes its pipes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-rg-cancel-'));
        const controller = new AbortController();
        let launcher: ChildProcess | undefined;
        let pipesClosed = false;
        processProbe.observe = child => {
            launcher = child;
            child.once('close', () => { pipesClosed = true; });
        };
        const fixtureProcesses = async () => {
            const rows = await Promise.all((await readdir('/proc')).filter(pid => /^\d+$/.test(pid)).map(async pid => {
                const argv = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
                if (!argv.includes(root)) return null;
                const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
                return { pid: Number(pid), ppid: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]) };
            }));
            return rows.filter(row => row !== null);
        };
        try {
            const fifo = join(root, 'f'.repeat(180));
            expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
            // Every batch blocks in a real native read. The repeated admitted
            // operands exceed the portable launcher boundary several times.
            const pending = run(['--no-config', '-e', 'needle'], {
                paths: Array.from({ length: 1500 }, () => fifo), signal: controller.signal,
            });
            const outcome = pending.then(value => ({ value }), error => ({ error }));
            await vi.waitFor(async () => {
                expect(launcher?.pid).toBeTypeOf('number');
                expect((await fixtureProcesses()).some(row => row.ppid === launcher?.pid)).toBe(true);
            });
            controller.abort();
            expect(await outcome).toMatchObject({ error: { name: 'AbortError', code: 'RIPGREP_ABORTED' } });
            await vi.waitFor(async () => {
                // Check all matching native children, including PPID 1, rather
                // than mistaking the first child's exit for complete cleanup.
                expect(await fixtureProcesses()).toEqual([]);
                expect(pipesClosed).toBe(true);
            }, { timeout: 5000 });
        } finally {
            controller.abort();
            // Only synthetic fixture-owned operands authorize cleanup here.
            for (const row of await fixtureProcesses()) {
                try { process.kill(row.pid, 'SIGKILL'); } catch { /* exited during observation */ }
            }
            if (launcher?.exitCode === null && launcher.signalCode === null) launcher.kill('SIGKILL');
            processProbe.observe = undefined;
            await rm(root, { recursive: true, force: true });
        }
    });

    it('searches a real rollout family above the launch boundary, including its last file and escaped queries', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-rg-large-'));
        try {
            const home = join(root, 'r'.repeat(180));
            const dir = join(home, 'sessions', '2026', '10', '16');
            await mkdir(dir, { recursive: true });
            const id = '019a1234-1234-7123-8123-123456789abc';
            const paths = Array.from({ length: 1000 }, (_, i) => join(dir,
                `rollout-2026-10-16T10-${String(Math.floor(i / 60)).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-${id}.jsonl`));
            const query = '\\'.repeat(2000);
            await Promise.all(paths.map((path, i) => writeFile(path, [
                { type: 'session_meta', payload: { id, cwd: '/repo' } },
                { type: 'response_item', timestamp: new Date(i * 1000).toISOString(), payload: {
                    type: 'message', role: 'user', content: [{ type: 'input_text', text: i === paths.length - 1 ? query : 'ordinary text' }],
                } },
            ].map(row => JSON.stringify(row)).join('\n') + '\n')));
            expect(Buffer.byteLength(JSON.stringify(paths))).toBeGreaterThan(131072);
            const ripgrep = { run: (request: { args: readonly string[]; paths: readonly string[]; signal?: AbortSignal }) =>
                run([...request.args], { paths: request.paths, signal: request.signal }) };
            const matches = await prefilterExternalSessionContentPaths({ query, paths, ripgrep });
            expect(matches?.has(paths[paths.length - 1]!)).toBe(true);
            expect(matches?.size).toBe(1);
            expect(await searchCodexExternalTranscript({ source: { kind: 'codexHome', home: 'user', homePath: home },
                env: { CODEX_HOME: home }, remoteSessionId: id, query, ripgrep }))
                .toMatchObject({ match: { snippet: query }, partial: false, unsearchable: false });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
});
