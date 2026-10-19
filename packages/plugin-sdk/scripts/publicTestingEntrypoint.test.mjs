import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const vitestCli = fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url));

for (const context of ['ordinary', 'inherited-vitest']) {
    test(`keeps the public testing entrypoint usable in an ${context} node:test process`, async () => {
        const directory = await mkdtemp(join(packageRoot, '.tmp.public-testing-'));
        try {
            // Preserve every public export while transpiling current source. The
            // child loads the real public specifier through its package map.
            await build({
                entryPoints: [join(packageRoot, 'src/testing/index.public.ts')],
                outfile: join(directory, 'testing.mjs'),
                bundle: true,
                packages: 'external',
                platform: 'node',
                format: 'esm',
                target: 'es2022',
            });
            await writeFile(join(directory, 'package.json'), JSON.stringify({
                name: '@happier-dev/plugin-sdk',
                type: 'module',
                exports: { './testing': './testing.mjs' },
            }));
            await writeFile(join(directory, 'public.test.mjs'), `
                import assert from 'node:assert/strict';
                import test from 'node:test';
                import {
                    createPluginTestkit, runAgentSkillDeliveryContract,
                    runAgentMcpToolPolicyContract,
                } from '@happier-dev/plugin-sdk/testing';
                test('imports the public kit and activates a plugin', async () => {
                    assert.equal(process.env.VITEST_WORKER_ID !== undefined, ${context === 'inherited-vitest'});
                    assert.equal(typeof runAgentSkillDeliveryContract, 'function');
                    assert.equal(typeof runAgentMcpToolPolicyContract, 'function');
                    for (const register of [runAgentSkillDeliveryContract, runAgentMcpToolPolicyContract]) {
                        assert.throws(() => register({}), error => {
                            assert.match(error.message, /require an active Vitest worker/);
                            ${context === 'inherited-vitest'
                                ? 'assert.match(error.cause.message, /Vitest failed to access its internal state/);'
                                : 'assert.equal(error.cause, undefined);'}
                            return true;
                        });
                    }
                    let activated = false;
                    const kit = await createPluginTestkit({
                        manifest: {
                            schemaVersion: 2, id: 'acme.node-testkit', version: '1.0.0',
                            displayName: 'Node testkit', runtime: { apiVersion: 1 }, contributes: {},
                        },
                        module: { activate() { activated = true; } },
                    });
                    try { assert.equal(activated, true); }
                    finally { await kit.dispose(); }
                });
            `);
            const env = { ...process.env };
            delete env.VITEST;
            delete env.VITEST_WORKER_ID;
            delete env.VITEST_POOL_ID;
            const consumerPath = join(directory, 'public.test.mjs');
            let args = ['--test', consumerPath];
            if (context === 'inherited-vitest') {
                await writeFile(join(directory, 'parent.test.mjs'), `
                    import assert from 'node:assert/strict';
                    import { spawnSync } from 'node:child_process';
                    import { it } from 'vitest';
                    it('passes its actual runner environment to an ordinary Node child', () => {
                        assert.notEqual(process.env.VITEST_WORKER_ID, undefined);
                        const child = spawnSync(process.execPath, ['--test', ${JSON.stringify(consumerPath)}], {
                            encoding: 'utf8', env: process.env,
                        });
                        assert.equal(child.error, undefined);
                        assert.equal(child.status, 0, child.stdout + child.stderr);
                    });
                `);
                const configPath = join(directory, 'vitest.config.mjs');
                // The outer node:test process owns this subprocess journey's
                // lifetime; do not impose a shorter unit cutoff on its child.
                await writeFile(configPath, 'export default { test: { include: ["parent.test.mjs"], fileParallelism: false, testTimeout: 0 } };');
                args = [vitestCli, 'run', '--root', directory, '--config', configPath];
            }
            const child = spawnSync(process.execPath, args, {
                cwd: directory,
                env,
                encoding: 'utf8',
            });
            assert.equal(child.error, undefined);
            assert.equal(child.status, 0, child.stdout + child.stderr);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
}
