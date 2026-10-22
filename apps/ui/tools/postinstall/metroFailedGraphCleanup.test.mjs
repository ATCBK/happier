import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyPatch, parsePatch, reversePatch } from 'diff';

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireFromUi = createRequire(path.join(uiDir, 'package.json'));
const patchPath = path.resolve(uiDir, '../../patches/metro@0.83.5.patch');

function createMetroFixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'happier-metro-failure-cleanup-')));
    try {
        const packageDir = path.join(root, 'node_modules/metro');
        const installedMetroDir = path.dirname(requireFromUi.resolve('metro/package.json'));
        fs.cpSync(installedMetroDir, packageDir, {
            recursive: true,
            filter: source => source !== path.join(installedMetroDir, 'node_modules'),
        });
        // Dependency support is read-only; Metro's owning classes execute from the
        // private package copy, never mutate the installation serving another Stack.
        const installedRequire = createRequire(path.join(installedMetroDir, 'package.json'));
        const dependencies = JSON.parse(fs.readFileSync(path.join(installedMetroDir, 'package.json'), 'utf8')).dependencies;
        for (const name of Object.keys(dependencies)) {
            const destination = path.join(root, 'node_modules', name);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.symlinkSync(path.dirname(installedRequire.resolve(`${name}/package.json`)), destination, 'junction');
        }
        // Normalize the private copy to the upstream preimage, then apply the
        // native pnpm patch; never mutate dependencies serving another Stack.
        for (const effect of parsePatch(fs.readFileSync(patchPath, 'utf8'))) {
            const file = path.join(packageDir, effect.newFileName.replace(/^b\//, ''));
            const installed = fs.readFileSync(file, 'utf8');
            const upstream = applyPatch(installed, reversePatch(effect));
            const patched = applyPatch(upstream === false ? installed : upstream, effect);
            assert.notEqual(patched, false, file);
            fs.writeFileSync(file, patched);
        }
        const projectRoot = path.join(root, 'project');
        fs.mkdirSync(projectRoot);
        fs.writeFileSync(path.join(projectRoot, 'entry.js'), "require('./good'); require('./missing');\n");
        fs.writeFileSync(path.join(projectRoot, 'good.js'), 'module.exports = "GOOD";\n');
        return { root, projectRoot, Server: requireFromUi(path.join(packageDir, 'src/Server.js')).default };
    } catch (error) {
        fs.rmSync(root, { recursive: true, force: true });
        throw error;
    }
}

async function startMetro(fixture) {
    const config = await requireFromUi('metro-config').getDefaultConfig(fixture.projectRoot);
    config.watchFolders = [fixture.projectRoot, path.dirname(requireFromUi.resolve('metro-runtime/package.json'))];
    config.maxWorkers = 1;
    config.resolver.useWatchman = false;
    config.resolver.nodeModulesPaths = [path.join(uiDir, 'node_modules'), path.resolve(uiDir, '../../node_modules')];
    config.cacheStores = [new (requireFromUi('metro-cache').FileStore)({ root: path.join(fixture.root, 'transforms') })];
    config.fileMapCacheDirectory = path.join(fixture.root, 'filemap');
    fs.mkdirSync(config.fileMapCacheDirectory);
    config.reporter = { update() {} };
    const metro = new fixture.Server(config, { watch: true });
    await metro.ready();
    return metro;
}

async function writeObservedModule(projectRoot, watcher, contents = 'module.exports = "RECOVERED";\n') {
    const filename = path.join(projectRoot, 'missing.js');
    const changed = new Promise(resolve => {
        const onChange = ({ eventsQueue }) => {
            if (!eventsQueue.some(event => event.filePath === filename)) return;
            watcher.off('change', onChange);
            resolve();
        };
        watcher.on('change', onChange);
    });
    fs.writeFileSync(filename, contents);
    await changed;
}

function requestBundle(port) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/entry.bundle?platform=web&dev=true&minify=false`, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('error', reject);
            response.on('end', () => resolve({ status: response.statusCode, body }));
        }).on('error', reject);
    });
}

test('failed initial HTTP graphs release subscriptions, then a recovered graph remains watched', async () => {
    const fixture = createMetroFixture();
    let metro;
    let listener;
    try {
        metro = await startMetro(fixture);
        const watcher = metro.getBundler().getBundler().getWatcher();
        const baseline = watcher.listenerCount('change');
        listener = http.createServer((request, response) => metro.processRequest(request, response, () => {
            response.statusCode = 404;
            response.end();
        }));
        await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
        const port = listener.address().port;
        for (let attempt = 0; attempt < 3; attempt++) {
            const response = await requestBundle(port);
            assert.equal(response.status, 500);
            assert.equal(JSON.parse(response.body).type, 'UnableToResolveError');
            assert.equal(watcher.listenerCount('change'), baseline, 'a rejected graph must release its watcher subscription');
        }
        await writeObservedModule(fixture.projectRoot, watcher);
        const recovered = await requestBundle(port);
        assert.equal(recovered.status, 200, recovered.body);
        assert.ok(recovered.body.includes('RECOVERED'));
        assert.equal(watcher.listenerCount('change'), baseline + 1, 'the successful graph retains its active subscription');
        const repeated = await requestBundle(port);
        assert.equal(repeated.status, 200);
        assert.equal(watcher.listenerCount('change'), baseline + 1);
        await writeObservedModule(fixture.projectRoot, watcher, "require('./stillMissing');\n");
        const failedUpdate = await requestBundle(port);
        assert.equal(failedUpdate.status, 500);
        assert.equal(JSON.parse(failedUpdate.body).type, 'UnableToResolveError');
        assert.equal(watcher.listenerCount('change'), baseline + 1, 'an existing graph remains watched after a failed update');
        await writeObservedModule(fixture.projectRoot, watcher, 'module.exports = "RECOVERED_AGAIN";\n');
        const recoveredUpdate = await requestBundle(port);
        assert.equal(recoveredUpdate.status, 200, recoveredUpdate.body);
        assert.ok(recoveredUpdate.body.includes('RECOVERED_AGAIN'));
        assert.equal(watcher.listenerCount('change'), baseline + 1);
        await metro.end();
        metro = null;
    } finally {
        if (metro) await metro.end();
        if (listener) await new Promise(resolve => listener.close(resolve));
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test('finite asset dependency traversal releases subscriptions on failure and success', async () => {
    const fixture = createMetroFixture();
    let metro;
    try {
        metro = await startMetro(fixture);
        const watcher = metro.getBundler().getBundler().getWatcher();
        const baseline = watcher.listenerCount('change');
        const options = { ...fixture.Server.DEFAULT_BUNDLE_OPTIONS, entryFile: path.join(fixture.projectRoot, 'entry.js'), platform: 'web' };
        for (let attempt = 0; attempt < 3; attempt++) {
            await assert.rejects(metro.getAssets(options), { type: 'UnableToResolveError' });
            assert.equal(watcher.listenerCount('change'), baseline, 'finite failed traversal must release its watcher subscription');
        }
        await writeObservedModule(fixture.projectRoot, watcher);
        assert.deepEqual(await metro.getAssets(options), []);
        assert.equal(watcher.listenerCount('change'), baseline);
    } finally {
        if (metro) await metro.end();
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});
