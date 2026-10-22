import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

test('ensureDepsInstalled keeps pnpm readiness probe output off stdout when not quiet', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hs-pm-pnpm-ready-stdout-' });
  const componentDir = fixture.path('component');
  const binDir = fixture.path('bin');
  await mkdir(componentDir);
  await mkdir(binDir);
  await mkdir(join(componentDir, 'node_modules'));
  await writeFile(join(componentDir, 'package.json'), '{"name":"component","version":"0.0.0"}');
  await writeFile(join(componentDir, 'pnpm-lock.yaml'), '# fixture');
  const manager = join(binDir, 'pnpm');
  await writeFile(manager, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('12.14.0');\n`);
  await chmod(manager, 0o755);
  const runnerPath = fixture.path('runner.mjs');
  await writeFile(runnerPath, `
    const { ensureDepsInstalled } = await import(process.env.PM_MODULE_URL);
    await ensureDepsInstalled(process.env.COMPONENT_DIR, 'stub-component', { quiet: false, env: process.env });
  `);
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
    COMPONENT_DIR: componentDir, HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
    PM_MODULE_URL: new URL('./pm.mjs', import.meta.url).href };
  delete env.npm_execpath;
  delete env.npm_node_execpath;
  const result = spawnSync(process.execPath, [runnerPath], { cwd: componentDir, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
