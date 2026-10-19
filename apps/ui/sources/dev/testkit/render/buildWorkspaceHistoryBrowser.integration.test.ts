import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { spawn } from 'node:child_process';

import { buildWorkspaceHistoryBrowser } from './buildWorkspaceHistoryBrowser.mjs';
import { workflowRouteStartupBrowserBuildTimeoutMs, workflowRouteStartupBrowserOptions } from './workflowRouteStartupBrowserOptions';

// The canonical process adapter is JavaScript; its boundary preserves Node's spawn contract.
const { spawnTestProcess } = createRequire(import.meta.url)('../../../../../stack/scripts/testkit/core/spawn_test_process.mjs') as { spawnTestProcess: typeof spawn };

test('Metro compilation retires its scratch on success and failure without changing the test runtime environment', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'happier-browser-builder-test-'));
    const previous = { NODE_ENV: process.env.NODE_ENV, BABEL_ENV: process.env.BABEL_ENV,
        TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    Object.assign(process.env, { NODE_ENV: 'test' });
    process.env.BABEL_ENV = 'test';
    process.env.TMPDIR = scratch;
    process.env.TMP = scratch;
    process.env.TEMP = scratch;
    try {
        const building = buildWorkspaceHistoryBrowser({
            entryFile: 'sources/dev/testkit/render/workflowRouteStartupProcessBoundary.ts',
            production: true,
        });
        const whileBuilding = { NODE_ENV: process.env.NODE_ENV, BABEL_ENV: process.env.BABEL_ENV };
        const code = await building;
        assert.equal(whileBuilding.NODE_ENV, 'test', 'the browser compiler must own its transform environment');
        assert.equal(whileBuilding.BABEL_ENV, 'test', 'the compiler must not change the active test transform environment');
        assert.ok(code.length > 0);
        // Metro also owns a persistent transform cache under TMPDIR. Only
        // this builder's allocated transfer directories must be retired.
        assert.deepEqual((await readdir(scratch)).filter(name => name.startsWith('happier-workspace-browser-')), []);
        await assert.rejects(buildWorkspaceHistoryBrowser({
            entryFile: 'sources/dev/testkit/render/missing-browser-entry.ts',
        }), /missing-browser-entry\.ts/);
        assert.deepEqual((await readdir(scratch)).filter(name => name.startsWith('happier-workspace-browser-')), []);
        assert.equal(process.env.NODE_ENV, 'test');
        assert.equal(process.env.BABEL_ENV, 'test');
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await rm(scratch, { recursive: true, force: true });
    }
});

test('an abandoned browser test terminates its Metro compiler when its IPC owner disconnects', async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), 'happier-browser-builder-test-'));
    const transfer = await mkdtemp(path.join(scratch, 'happier-workspace-browser-'));
    const child = spawnTestProcess(process.execPath, [fileURLToPath(new URL('./buildWorkspaceHistoryBrowser.mjs', import.meta.url)), '--metro-build'], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    try {
        assert.ok(child.stdout);
        assert.ok(child.stderr);
        assert.ok(child.send);
        const stdout = child.stdout;
        stdout.pipe(process.stdout, { end: false });
        child.stderr.pipe(process.stderr, { end: false });
        const send = child.send.bind(child);
        let errors = '';
        child.stderr.on('data', chunk => { errors += chunk; });
        let output = '';
        const compiling = new Promise<void>((resolve, reject) => {
            stdout.on('data', chunk => {
                output += chunk;
                if (output.includes('modules transformed')) resolve();
            });
            child.once('exit', () => reject(new Error(`Compiler ended before transforming its real app graph\n${errors}`)));
        });
        await new Promise<void>((resolve, reject) => send({
            options: workflowRouteStartupBrowserOptions,
            outputPath: path.join(transfer, 'bundle.js'),
        }, error => error ? reject(error) : resolve()));
        await compiling;
        child.disconnect();
        assert.deepEqual(await terminal, { code: 1, signal: null });
        assert.deepEqual(await readdir(scratch), []);
    } finally {
        if (child.connected) child.disconnect();
        await terminal;
        await rm(scratch, { recursive: true, force: true });
    }
}, workflowRouteStartupBrowserBuildTimeoutMs);
