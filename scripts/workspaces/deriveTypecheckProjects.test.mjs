import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { deriveTypecheckProjects } from './deriveTypecheckProjects.mjs';
import { prepareUiTypecheckProjects } from '../../apps/ui/scripts/deriveTypecheckProjects.mjs';
import { prepareCliTypecheckProjects } from '../../apps/cli/scripts/deriveTypecheckProjects.mjs';

for (const [app, prepare, names] of [
  ['ui', prepareUiTypecheckProjects, ['foundation', 'core', 'source', 'test-components', 'test-other']],
  ['cli', prepareCliTypecheckProjects, ['foundation', 'services', 'core', 'source', 'test']],
]) {
  test(`${app} public typecheck preparation removes deleted membership on every invocation`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'happier-compiler-membership-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packageDir = join(root, app);
    await mkdir(join(packageDir, 'src'), { recursive: true });
    await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: `membership-${app}` }));
    if (app === 'ui') {
      // Expo config is a real installed boundary; this fixture does not enable typed routes.
      await symlink(new URL('../../apps/ui/node_modules', import.meta.url), join(packageDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
      await writeFile(join(packageDir, 'app.json'), JSON.stringify({ expo: { name: 'Membership', slug: 'membership' } }));
    }
    await writeFile(join(packageDir, 'src/kept.ts'), 'export const kept = 1;');
    await writeFile(join(packageDir, 'src/deleted.ts'), 'export const deleted = 1;');
    await writeFile(join(packageDir, 'src/deleted.test.ts'), 'export const deletedTest = 1;');
    await writeFile(join(packageDir, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
    for (const name of new Set([...names, 'test'])) await writeFile(join(packageDir, `tsconfig.${name}.json`), JSON.stringify({
      extends: './tsconfig.json', files: name.startsWith('test') ? ['src/deleted.test.ts'] : ['src/deleted.ts'], include: [],
    }));
    const manifest = JSON.parse(await readFile(new URL(`../../apps/${app}/package.json`, import.meta.url), 'utf8'));
    // Consume the actual public owner's finite command, so a stale entrypoint cannot bypass preparation unnoticed.
    const projects = () => [...manifest.scripts['typecheck:source:finite'].matchAll(/--project (\S+)/g)].map(([, project]) => ({
      project, args: ['--project', project],
    }));
    const initial = await prepare(projects(), packageDir);
    assert.ok(initial, 'the public project set must reach preparation');
    const membership = async inventory => (await Promise.all(inventory.map(async ({ configPath }) => JSON.parse(await readFile(configPath, 'utf8')).files))).flat();
    assert.ok((await membership(initial)).includes(resolve(packageDir, 'src/deleted.ts')));
    await rm(join(packageDir, 'src/deleted.ts'));
    await rm(join(packageDir, 'src/deleted.test.ts'));
    const nextProjects = projects();
    const next = await prepare(nextProjects, packageDir);
    const files = await membership(next);
    assert.ok(files.includes(resolve(packageDir, 'src/kept.ts')), 'valid source remains checked');
    assert.ok(!files.includes(resolve(packageDir, 'src/deleted.ts')), 'deleted implementation leaves membership');
    assert.ok(!files.includes(resolve(packageDir, 'src/deleted.test.ts')), 'deleted explicit test leaves membership');
    for (const project of nextProjects) assert.equal(project.args[1], project.project, 'compiler arguments consume the regenerated projection');
  });
}

test('dependency partitions keep cycles whole and prerequisites before their consumers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compiler-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'src/leaf.ts': 'export const leaf = 1;',
    'src/service.ts': 'import { leaf } from "./leaf"; export const service = leaf;',
    'src/a.ts': 'import "./b"; import "./service";',
    'src/b.ts': 'import "./c";',
    'src/c.ts': 'import "./a";',
    'src/entry.ts': 'import "./a";',
    'src/new.test.ts': 'import "./entry";',
    'src/globals.d.ts': 'declare const shared: string;',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler', module: 'esnext' }, include: ['src/**/*'] }));
  const names = ['foundation', 'services', 'core', 'source', 'test'];
  for (const [index, name] of names.entries()) await writeFile(join(root, `tsconfig.${name}.json`), JSON.stringify({
    extends: './tsconfig.json', files: ['src/globals.d.ts'], include: [],
    references: names.slice(0, index).map(previous => ({ path: `./tsconfig.${previous}.json` })),
  }));
  const inventory = await deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'] });
  const configs = await Promise.all(inventory.map(async ({ configPath }) => JSON.parse(await readFile(configPath, 'utf8'))));
  const owned = path => configs.findIndex(config => config.files.includes(resolve(root, path)));
  for (const path of Object.keys(files).filter(path => !path.endsWith('.d.ts'))) assert.equal(configs.filter(config => config.files.includes(resolve(root, path))).length, 1, path);
  assert.equal(owned('src/leaf.ts'), 0);
  assert.equal(owned('src/service.ts'), 1);
  for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) assert.equal(owned(path), 2, path);
  assert.equal(owned('src/entry.ts'), 3);
  assert.equal(owned('src/new.test.ts'), 4);
  assert.ok(configs.every(config => config.files.includes(resolve(root, 'src/globals.d.ts'))));
  assert.equal(configs[3].references[2].path, inventory[2].configPath, 'references consume the derived producer graph');
  await deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'], check: true });
  await deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'], writeAuthored: true });
  const authoredSource = JSON.parse(await readFile(join(root, 'tsconfig.source.json'), 'utf8'));
  assert.ok(authoredSource.files.includes('src/entry.ts'), 'explicit regeneration refreshes tracked membership through the same graph owner');
  assert.deepEqual(authoredSource.references, names.slice(0, 3).map(name => ({ path: `./tsconfig.${name}.json` })), 'authored references retain portable paths');
  await writeFile(join(root, 'src/new-entry.ts'), 'import "./entry";');
  await assert.rejects(deriveTypecheckProjects(root, { sourceNames: names.slice(0, -1), testNames: ['test'], check: true }), /need regeneration/);
});
