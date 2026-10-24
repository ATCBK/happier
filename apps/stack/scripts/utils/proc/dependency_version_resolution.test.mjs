import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';

const execute = promisify(execFile);
const hook = fileURLToPath(new URL('./dependency_version_resolution.mjs', import.meta.url));

test('selected physical dependencies survive live lookup changes, ESM, late children and package-local shadowing', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-versioned-resolution-' });
  const source = fixture.path('source');
  const selected = fixture.path('version-a');
  const put = async (root, path, contents) => {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  };
  for (const [root, value] of [[source, 'B'], [selected, 'A']]) {
    await put(root, 'package.json', '{"private":true,"type":"module"}');
    await put(root, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n');
    await put(root, 'apps/ui/package.json', '{"name":"ui","type":"module"}');
    await put(root, 'packages/owned/package.json', '{"name":"@happier-dev/owned","type":"module","exports":"./index.mjs"}');
    await put(root, 'packages/owned/index.mjs', `export default ${JSON.stringify(`source-${value}`)};`);
    for (const [base, label] of [['node_modules/probe', `root-${value}`], ['apps/ui/node_modules/probe', `ui-${value}`],
      ['apps/ui/node_modules/late', `late-${value}`]]) {
      await put(root, `${base}/package.json`, '{"type":"commonjs","main":"index.cjs"}');
      await put(root, `${base}/index.cjs`, `module.exports=${JSON.stringify(label)};`);
    }
  }
  await put(source, 'apps/ui/main.mjs', `
    import { createRequire } from 'node:module';
    import { execFileSync } from 'node:child_process';
    import esm from 'probe';
    import owned from '../../packages/owned/index.mjs';
    const require = createRequire(import.meta.url);
    const child = execFileSync(process.execPath, ['--input-type=module', '-e',
      'import {createRequire} from "node:module"; const r=createRequire(process.cwd()+"/child.cjs"); console.log(JSON.stringify([r("probe"),r("late")]))'],
      {cwd:new URL('.',import.meta.url),env:process.env,encoding:'utf8'});
    console.log(JSON.stringify({esm,cjs:require('probe'),late:require('late'),owned,child:JSON.parse(child)}));
  `);
  const env = { ...process.env, HAPPIER_DEPENDENCY_SOURCE_ROOT: source,
    HAPPIER_DEPENDENCY_VERSION_ROOT: selected, HAPPIER_DEPENDENCY_VERSION_ID: 'identity-a' };
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${JSON.stringify(hook)}`].filter(Boolean).join(' ');
  const { stdout } = await execute(process.execPath, [join(source, 'apps/ui/main.mjs')], { env });
  assert.deepEqual(JSON.parse(stdout), { esm: 'ui-A', cjs: 'ui-A', late: 'late-A', owned: 'source-B', child: ['ui-A', 'late-A'] });
});
