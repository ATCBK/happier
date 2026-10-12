import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import test from 'node:test';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(uiRoot, 'package.json'));

test('Connected Account authoring bundles in browser and native without its host filesystem client', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'happier-connected-accounts-metro-'));
    let server;
    try {
        const entry = join(fixture, 'index.js');
        await writeFile(entry, `import {
            CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
            buildConnectedAccountRequestAuthClientSource,
            ConnectedAccountPurposeDeclarationsV1Schema,
        } from '@happier-dev/plugin-sdk/connected-accounts';
        globalThis.connectedAccountAuthoring = {
            source: buildConnectedAccountRequestAuthClientSource({
                capabilityPathEnv: CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV,
            }),
            purposes: ConnectedAccountPurposeDeclarationsV1Schema.parse([]),
        };`);
        const config = require(join(uiRoot, 'metro.config.js'));
        config.watchFolders = [...config.watchFolders, fixture];
        config.maxWorkers = 2;
        config.cacheStores = [new (require('metro-cache').FileStore)({ root: join(fixture, 'transforms') })];
        config.fileMapCacheDirectory = join(fixture, 'filemap');
        await mkdir(config.fileMapCacheDirectory, { recursive: true });
        config.reporter = { update() {} };
        const Server = require('metro/private/Server').default;
        server = new Server(config, { watch: false });
        for (const platform of ['web', 'android']) {
            const bundle = await server.build({ ...Server.DEFAULT_BUNDLE_OPTIONS,
                entryFile: entry, platform, dev: true, minify: false, lazy: false,
            });
            const graph = [...server.getBundler().getDeltaBundler()._deltaCalculators.keys()].at(-1);
            const paths = [...graph.dependencies.keys()].map(file => file.replaceAll('\\', '/'));
            assert.equal(paths.some(file => file.endsWith('/connected-accounts/requestAuthClient.ts')), false);
            assert.equal(paths.some(file => file.includes('/node_modules/node-libs-browser/')), false);
            const sandbox = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder };
            sandbox.global = sandbox;
            new Script(bundle.code).runInNewContext(sandbox);
            assert.match(sandbox.connectedAccountAuthoring.source, /function lookupConnectedAccountRequestAuth/);
            assert.equal(sandbox.connectedAccountAuthoring.purposes.length, 0);
            console.log(JSON.stringify({ platform, modules: paths.length, bytes: Buffer.byteLength(bundle.code) }));
        }
    } finally {
        if (server) await server.end();
        await rm(fixture, { recursive: true, force: true });
    }
});
