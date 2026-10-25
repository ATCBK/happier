import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { fileURLToPath } from 'node:url';

import { buildPierreWorkerAssets, resolveWorkerDistDir } from './buildPierreWorker.mjs';

const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture({ worker = 'const wasm = import("./wasm-example.js");\n//# sourceMappingURL=worker.js.map', version = '1.5.2' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pierre-worker-'));
    fixtureRoots.push(root);
    const expoAppDir = path.join(root, 'apps/ui');
    const packageDir = path.join(expoAppDir, 'node_modules/@pierre/diffs');
    const workerDistDir = path.join(packageDir, 'dist/worker');
    fs.mkdirSync(workerDistDir, { recursive: true });
    fs.mkdirSync(path.join(expoAppDir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(workerDistDir, 'worker-portable.js'), worker);
    fs.writeFileSync(path.join(workerDistDir, 'wasm-example.js'), 'export const wasm = true;');
    return { repoRootDir: root, expoAppDir, workerDistDir };
}

test('publishes a matching versioned worker and helper, removing only previous Pierre worker artifacts', () => {
    const inputs = fixture();
    const publicDir = path.join(inputs.expoAppDir, 'public');
    const oldArtifacts = [
        'pierre-diff-worker.js', 'pierre-diff-worker-wasm.js',
        'pierre-diff-worker.1.1.0-beta.13.js', 'pierre-diff-worker-wasm.1.1.0-beta.13.js',
    ];
    for (const name of [...oldArtifacts, 'pierre-diff-worker-notes.js', 'other-worker.js']) {
        fs.writeFileSync(path.join(publicDir, name), 'old');
    }

    const result = buildPierreWorkerAssets(inputs);

    assert.equal(path.basename(result.outWorkerPath), 'pierre-diff-worker.1.5.2.js');
    assert.equal(path.basename(result.outWasmPath), 'pierre-diff-worker-wasm.1.5.2.js');
    assert.equal(fs.readFileSync(result.outWorkerPath, 'utf8'), 'const wasm = import("./pierre-diff-worker-wasm.1.5.2.js");\n');
    assert.equal(fs.readFileSync(result.outWasmPath, 'utf8'), 'export const wasm = true;');
    for (const name of oldArtifacts) assert.equal(fs.existsSync(path.join(publicDir, name)), false, name);
    assert.equal(fs.readFileSync(path.join(publicDir, 'pierre-diff-worker-notes.js'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(publicDir, 'other-worker.js'), 'utf8'), 'old');
    assert.equal(buildPierreWorkerAssets(inputs).wroteWorker, false);
});

test('rewrites the real installed portable worker to its emitted helper', () => {
    // The workspace installs hoisted; read the copy the builder itself resolves.
    const installedWorkerDir = resolveWorkerDistDir({
        repoRootDir: fileURLToPath(new URL('../../../..', import.meta.url)),
        expoAppDir: fileURLToPath(new URL('../..', import.meta.url)),
    });
    assert.ok(installedWorkerDir, 'installed @pierre/diffs worker dist');
    const installedPackage = JSON.parse(fs.readFileSync(path.resolve(installedWorkerDir, '../../package.json'), 'utf8'));
    const inputs = fixture({ version: installedPackage.version });
    fs.cpSync(installedWorkerDir, inputs.workerDistDir, { recursive: true });

    const result = buildPierreWorkerAssets(inputs);

    assert.equal(path.basename(result.outWorkerPath), `pierre-diff-worker.${installedPackage.version}.js`);
    assert.ok(fs.readFileSync(result.outWorkerPath, 'utf8').includes(`import("./${path.basename(result.outWasmPath)}")`));
    assert.equal(fs.readFileSync(result.outWasmPath, 'utf8'), fs.readFileSync(path.join(installedWorkerDir, result.wasmSourceFileName), 'utf8'));
});
