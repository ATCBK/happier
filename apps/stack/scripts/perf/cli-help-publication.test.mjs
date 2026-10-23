import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('plain-Node bundled help publication loads metadata, never command presentation callbacks', async () => {
  const registry = new URL('../../../cli/scripts/build-owned/bundledPlugins/registry.ts', import.meta.url).href;
  const { stdout } = await execute(process.execPath, ['--conditions=happier-source', '--input-type=module', '--eval', `
    import { Session } from 'node:inspector';
    const inspector = new Session();
    const scripts = [];
    inspector.connect();
    inspector.on('Debugger.scriptParsed', ({ params }) => scripts.push(params.url));
    await new Promise((resolve, reject) => inspector.post('Debugger.enable', error => error ? reject(error) : resolve()));
    const { renderCliBundledActionCliHelpAssets } = await import(${JSON.stringify(registry)});
    const assets = renderCliBundledActionCliHelpAssets({ pluginPackages: [] });
    inspector.disconnect();
    console.log(JSON.stringify({ scripts, paths: assets.map(asset => asset.relativePath) }));
  `], { cwd: fileURLToPath(new URL('../../../../', import.meta.url)), maxBuffer: 8 * 1024 * 1024 });
  const { scripts, paths } = JSON.parse(stdout);
  assert.ok(scripts.some(path => path.endsWith('/build-owned/bundledPlugins/registry.ts')),
    'the real generator projection owner is evaluated');
  assert.ok(paths.some(path => path.endsWith('generatedBundledActionCliHelp.ts')));
  assert.deepEqual(scripts.filter(path => /\/cli\/(?:actions\/commandPresentation|commands\/.*Presentation)\.ts$/u.test(path)), [],
    'publication consumes the shared static envelope metadata without loading output callbacks');
});
