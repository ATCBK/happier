import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('CLI source imports resolve the errors runtime rather than an erased declaration file', async () => {
  const { stdout } = await execute(process.execPath, ['--conditions=happier-source',
    '--import', '../../packages/cli-common/registerSourceRuntime.mjs', '--input-type=module', '--eval', `
      const { PluginError, isPluginError } = await import('@happier-dev/plugin-sdk/errors');
      console.log(JSON.stringify({ recognized: isPluginError(new PluginError({ code: 'fixture_unavailable' })) }));
    `], { cwd: fileURLToPath(new URL('../../../apps/cli/', import.meta.url)), maxBuffer: 1024 * 1024 });
  assert.equal(JSON.parse(stdout).recognized, true);
});

test('the public errors leaf is lightweight and shares the root error identity', async () => {
  const { stdout } = await execute(process.execPath, ['--conditions=happier-source', '--input-type=module', '--eval', `
    await import('../../packages/cli-common/registerSourceRuntime.mjs');
    const { Session } = await import('node:inspector');
    const inspector = new Session();
    const scripts = [];
    inspector.connect();
    inspector.on('Debugger.scriptParsed', ({ params }) => scripts.push(params.url));
    await new Promise((resolve, reject) => inspector.post('Debugger.enable', error => error ? reject(error) : resolve()));
    const leaf = await import('@happier-dev/plugin-sdk/errors');
    const beforeRoot = [...scripts];
    const root = await import('@happier-dev/plugin-sdk');
    const error = new root.PluginError({ code: 'fixture_unavailable', retryable: true });
    inspector.disconnect();
    console.log(JSON.stringify({ beforeRoot, exports: Object.keys(leaf), sameClass: root.PluginError === leaf.PluginError,
      recognized: leaf.isPluginError(error), rootRecognized: root.isPluginError(new leaf.PluginError({ code: 'fixture_unavailable' })) }));
  `], { cwd: fileURLToPath(new URL('../', import.meta.url)), maxBuffer: 8 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.exports.sort(), ['PluginError', 'isPluginError']);
  assert.equal(result.sameClass, true);
  assert.equal(result.recognized, true);
  assert.equal(result.rootRecognized, true);
  assert.ok(result.beforeRoot.some(url => /\/plugin-sdk\/src\/errors\.ts$/u.test(url)));
  assert.deepEqual(result.beforeRoot.filter(url => (
    /\/plugin-sdk\/src\/(?:index|activation|definePlugin|manifest)\.ts$/u.test(url)
    || /\/packages\/agents\//u.test(url)
  )), [], 'error handling does not evaluate the SDK contribution or Agent catalog');
});
