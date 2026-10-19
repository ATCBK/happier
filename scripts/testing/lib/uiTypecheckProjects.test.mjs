import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import { resolveTypeScriptCliInvocation } from '../../workspaces/resolveTypeScriptCliInvocation.mjs';
import { installNativeAdmissionFixture } from '../../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';

const uiDir = resolve('apps/ui');
function readProject(name, packageDir = uiDir) {
  const configPath = resolve(packageDir, name);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error && ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    undefined, `${name} must exist and parse`);
  const project = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath), undefined, configPath);
  assert.deepEqual(project.errors, []);
  return project;
}

function isSharedDeclaration(file) {
  if (!file.endsWith('.d.ts')) return false;
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return !ts.isExternalModule(source) || source.statements.some((statement) =>
    ts.isModuleDeclaration(statement) && (ts.isStringLiteral(statement.name)
      || Boolean(statement.flags & ts.NodeFlags.GlobalAugmentation)));
}

function publicFiniteCompiler(packageDir, fixtureDir, write, invocation, admission = null) {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const [command, owner, ...compilerArgs] = pkg.scripts['typecheck:source:finite'].trim().split(/\s+/u);
  assert.equal(command, 'node');
  assert.equal(resolve(packageDir, owner), resolve('scripts/workspaces/runTypeScriptCli.mjs'));
  const projects = [];
  const fixtureArgs = compilerArgs.map((arg, index) => {
    if (compilerArgs[index - 1] === '--verifyProjectCoverage') return join(fixtureDir, arg);
    if (!['--project', '-p'].includes(compilerArgs[index - 1])) return arg;
    projects.push(arg);
    return join(fixtureDir, arg);
  });
  const spawnLog = join(fixtureDir, 'compiler-spawns.jsonl');
  const preload = join(fixtureDir, 'record-compiler-spawns.cjs');
  // Observe only the genuine OS spawn boundary; execute the native compiler
  // unchanged, including the measured Linux adapter's compiler invocation.
  write('record-compiler-spawns.cjs', `
    const cp = require('node:child_process');
    const spawn = cp.spawn;
    cp.spawn = function(command, args, options) {
      const compilerIndex = args.indexOf(${JSON.stringify(invocation.compilerPath)});
      const compilerArgs = compilerIndex >= 0 ? args.slice(compilerIndex + 1) : null;
      if (compilerArgs) require('node:fs').appendFileSync(${JSON.stringify(spawnLog)}, JSON.stringify(compilerArgs) + '\\n');
      ${admission ? `
      if (args[0] === '--heavyweight-admission') command = ${JSON.stringify(admission.launcher)};
      if (command === 'python3' && args[3] === '--heavyweight-admission') args = [args[0], args[1], ${JSON.stringify(admission.launcher)}, ...args.slice(3)];
      ` : ''}
      return spawn(command, args, options);
    };
    require('node:module').syncBuiltinESMExports();
  `);
  return {
    projects,
    run: (extraArgs = []) => spawnSync(process.execPath, [resolve(packageDir, owner), ...fixtureArgs, ...extraArgs], {
      cwd: fixtureDir, encoding: 'utf8',
      env: { ...process.env, CI: 'true', HAPPIER_TYPESCRIPT_CLI_MEASURE_RSS: '1',
        ...(admission ? { PATH: `${join(fixtureDir, 'bin')}:${process.env.PATH}`, HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: '',
          HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT: admission.admissionRoot } : {}),
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}` },
    }),
    nativeCalls: () => readFileSync(spawnLog, 'utf8').trim().split('\n').map(JSON.parse),
  };
}

function assertOneCheckerInvocations(nativeCalls, projects) {
  assert.deepEqual(nativeCalls.map((args) => args[args.findIndex((arg) => arg === '--project' || arg === '-p') + 1]), projects);
  for (const args of nativeCalls) {
    const checkerOption = args.indexOf('--singleThreaded');
    assert.equal(args.filter((arg) => arg === '--singleThreaded').length, 1,
      'each host project must execute the native compiler with one checker');
    assert.ok(checkerOption >= 0 && args[checkerOption + 1] !== 'false',
      'each host project must execute the native compiler with one checker');
  }
}

function assertProjectCoverage(packageDir, sourceNames, testNames = ['tsconfig.test.json'], peerReferences = [], declarationOverrides = new Map()) {
  const original = readProject('tsconfig.json', packageDir);
  const sources = sourceNames.map((name) => readProject(name, packageDir));
  const tests = testNames.map((name) => readProject(name, packageDir));
  const currentRoot = file => declarationOverrides.get(file) ?? file;
  const originalRoots = new Set([...original.fileNames.map(currentRoot), ...declarationOverrides.values()]);
  const sharedRoots = new Set([...originalRoots].filter(isSharedDeclaration));
  const expectedRoots = new Set([...originalRoots, ...readProject('tsconfig.test.json', packageDir).fileNames
    .filter(file => existsSync(file) && !file.includes('.composed.')).map(currentRoot)]);
  const projects = [...sources, ...tests];
  const counts = new Map();
  for (const project of projects) {
    for (const file of project.fileNames.filter((file) => expectedRoots.has(file))) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    const plumbing = new Set(['configFilePath', 'composite', 'noEmit', 'emitDeclarationOnly',
      'rootDir', 'outDir', 'tsBuildInfoFile', 'disableSourceOfProjectReferenceRedirect']);
    const strictOptions = (options) => Object.fromEntries(Object.entries(options)
      .filter(([key]) => !plumbing.has(key)));
    assert.deepEqual(strictOptions(project.options), strictOptions(original.options));
  }
  assert.deepEqual([...counts.keys()].sort(), [...expectedRoots].sort());
  for (const [file, count] of counts) {
    const expected = sharedRoots.has(file) ? projects.length : 1;
    assert.equal(count, expected, file);
  }
  for (const source of sources) {
    assert.equal(source.options.composite, true);
    assert.equal(source.options.emitDeclarationOnly, true);
    assert.equal(source.options.noEmit, false);
  }
  for (const project of tests) {
    assert.equal(project.options.noEmit, true);
    assert.equal(project.options.disableSourceOfProjectReferenceRedirect, true);
    assert.deepEqual(project.projectReferences.map(({ path }) => path),
      [sourceNames.at(-1), ...peerReferences].map(name => resolve(packageDir, name)));
  }
  assert.equal(new Set(tests.map((project) => project.options.tsBuildInfoFile)).size, tests.length);
}

test('UI projects preserve every original root across complementary test partitions', async () => {
  const { prepareUiTypecheckProjects } = await import('../../../apps/ui/scripts/deriveTypecheckProjects.mjs');
  const pkg = JSON.parse(readFileSync(join(uiDir, 'package.json'), 'utf8'));
  const args = pkg.scripts['typecheck:source:finite'].trim().split(/\s+/u);
  const projects = args.filter((arg, index) => ['--project', '-p'].includes(args[index - 1]));
  const sources = ['tsconfig.foundation.json', 'tsconfig.core.json', 'tsconfig.source.json'];
  const tests = ['tsconfig.test-components.json', 'tsconfig.test-other.json'];
  assert.deepEqual(projects, [...sources, ...tests], 'public typecheck must check both test groups instead of the monolithic project');
  const inventory = await prepareUiTypecheckProjects(projects.map(project => ({ project })), uiDir);
  const derivedSources = inventory.slice(0, sources.length).map(({ configPath }) => relative(uiDir, configPath));
  const derivedTests = inventory.slice(sources.length).map(({ configPath }) => relative(uiDir, configPath));
  const routeDeclaration = join(uiDir, 'node_modules/.cache/tsc/router.d.ts');
  assertProjectCoverage(uiDir, derivedSources, derivedTests, [], new Map([
    [join(uiDir, '.expo/types/router.d.ts'), routeDeclaration],
  ]));
  const baseline = readProject('tsconfig.test.json');
  const groups = derivedTests.map((name) => readProject(name));
  const isTest = (file) => /\.(?:test|spec)\.tsx?$/u.test(file);
  const originalTests = [...new Set([...readProject('tsconfig.json').fileNames, ...baseline.fileNames])]
    .filter(file => existsSync(file) && !file.includes('.composed.') && isTest(file));
  const groupTests = groups.map((project) => project.fileNames.filter(isTest));
  assert.deepEqual(groupTests.flat().sort(), originalTests.sort(), 'every original test/spec root is checked exactly once');
  assert.ok(groupTests.every((files) => files.length > 0));
  assert.ok(groupTests[0].every((file) => file.replaceAll('\\', '/').includes('/sources/components/')));
  assert.ok(groupTests[1].every((file) => !file.replaceAll('\\', '/').includes('/sources/components/')));
  for (const project of groups) {
    assert.ok(project.fileNames.every((file) => !file.replaceAll('\\', '/').includes('/sources/trash/')
      && (!file.replaceAll('\\', '/').includes('/node_modules/') || file === routeDeclaration)));
  }
});

test('native UI source emission leaves test-only Protocol and SDK fixtures in the noEmit project', async () => {
  const { prepareUiTypecheckProjects } = await import('../../../apps/ui/scripts/deriveTypecheckProjects.mjs');
  const names = ['foundation', 'core', 'source', 'test-components', 'test-other'];
  const inventory = await prepareUiTypecheckProjects(names.map(name => ({ project: `tsconfig.${name}.json` })), uiDir);
  const configs = new Map(inventory.map(({ project, configPath }) => [project, configPath]));
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: uiDir });
  const inputs = (name) => {
    const result = spawnSync(invocation.command, [...invocation.argsPrefix,
      '--project', configs.get(name), '--listFilesOnly'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim().split(/\r?\n/u).map((file) => resolve(file.trim()));
  };
  for (const name of ['foundation', 'core', 'source']) {
    const roots = new Set(readProject(configs.get(name)).fileNames.map((file) => resolve(file)));
    const unlisted = inputs(name).filter((file) => /\.[cm]?tsx?$/u.test(file) && !/\.d\.[cm]?ts$/u.test(file) && !roots.has(file));
    assert.equal(unlisted.length, 0, `${name} must own every source it declaration-emits; later partitions must not be pulled into earlier ones: ${unlisted.slice(0, 12).join(', ')}`);
  }
  const sourceInputs = inputs('source');
  const protocolDir = resolve('packages/protocol/src') + '/';
  const authorFixtureDirs = ['packages/plugin-sdk/examples/', 'packages/plugin-sdk/fixtures/']
    .map((dir) => resolve(dir) + '/');
  assert.deepEqual(sourceInputs.filter((file) => file.startsWith(protocolDir)), [],
    'Protocol authored schemas reached only from UI tests/configuration must not be declaration-emitted by UI');
  assert.deepEqual(sourceInputs.filter((file) => authorFixtureDirs.some((dir) => file.startsWith(dir))), [],
    'authoring examples and test fixtures belong to semantic checking, not app declaration publication');
  const testOnlyRoots = [
    'vitest.config.ts', 'vitest.integration.config.ts',
    'vitest.legend-native.config.ts', 'vitest.legend-fabric.config.ts',
    'sources/dev/testkit/fixtures/pluginWidgetProjectionFixtures.ts',
  ].map((file) => join(uiDir, file));
  assert.ok(testOnlyRoots.every((file) => !sourceInputs.includes(file)));
  const testInputs = [...new Set(['test-components', 'test-other'].flatMap(inputs))];
  assert.ok(testOnlyRoots.every((file) => testInputs.includes(file)),
    'each original test/configuration root must still be checked');
  assert.ok(testInputs.some((file) => file.startsWith(protocolDir)));
  assert.ok(testInputs.some((file) => authorFixtureDirs.some((dir) => file.startsWith(dir))));
  const verifiedEmail = resolve('packages/protocol/src/auth/verifiedEmail.ts');
  assert.ok(testInputs.includes(verifiedEmail),
    'the retained Board testkit imports must still check verified-mailbox normalization');
  const ambientRoots = readProject('tsconfig.test.json').fileNames
    .filter((file) => file.startsWith(protocolDir) && isSharedDeclaration(file));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-ui-test-protocol-ambient-'));
  try {
    const config = join(fixtureDir, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({
      extends: join(uiDir, 'tsconfig.test.json'),
      compilerOptions: { tsBuildInfoFile: join(fixtureDir, 'types.tsbuildinfo') },
      references: [], include: [], files: [verifiedEmail, ...ambientRoots],
    }));
    // Check the real reachable owner with the test project's canonical ambient roots,
    // without declaration emission or the app's full semantic graph.
    const semantic = spawnSync(invocation.command, [...invocation.argsPrefix,
      '--noEmit', '--project', config, '--pretty', 'false'], { encoding: 'utf8' });
    assert.equal(semantic.status, 0, semantic.stdout + semantic.stderr);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

for (const name of ['foundation', 'core']) {
  test(`native UI ${name} partition loads shared theme and breakpoint augmentation`, () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-ui-theme-types-'));
    const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: uiDir });
    const actual = ts.readConfigFile(join(uiDir, `tsconfig.${name}.json`), ts.sys.readFile).config;
    const base = ts.readConfigFile(join(uiDir, 'tsconfig.json'), ts.sys.readFile).config;
    const write = (file, content) => {
      mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
      writeFileSync(join(fixtureDir, file), content);
    };
    const run = () => spawnSync(invocation.command,
      [...invocation.argsPrefix, '--project', join(fixtureDir, 'tsconfig.json'), '--pretty', 'false'],
      { encoding: 'utf8', cwd: fixtureDir });
    try {
      // Keep the installed library's real augmentation seam and the partition's
      // real include rules; only replace the app Theme's large runtime closure.
      const paths = Object.fromEntries(Object.entries(base.compilerOptions.paths)
        .map(([key, values]) => [key, values.map((value) => resolve(uiDir, value))]));
      paths['@/*'] = ['./sources/*'];
      write('tsconfig.json', JSON.stringify({
        extends: join(uiDir, 'tsconfig.json'),
        compilerOptions: { ...actual.compilerOptions, types: [], paths, rootDir: '.',
          outDir: './cache', tsBuildInfoFile: './cache/types.tsbuildinfo' },
        files: ['sources/theme.ts', 'sources/consumer.ts', 'sources/adapter.ts'], include: ['sources/types/*.d.ts'], exclude: [],
      }));
      for (const file of readdirSync(join(uiDir, 'sources/types')).filter((file) => file.endsWith('.d.ts'))) {
        const content = readFileSync(join(uiDir, 'sources/types', file), 'utf8');
        const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
        if (source.statements.some((statement) => ts.isModuleDeclaration(statement)
          && ts.isStringLiteral(statement.name) && statement.name.text === 'react-native-unistyles')) {
          write(`sources/types/${file}`, content);
        }
      }
      write('sources/theme.ts', 'export type Theme = { dark: boolean; colors: { surface: { base: string } } };\n');
      // Compile the actual owner expression and its public adapter type without
      // importing the app's persistence and theme-profile runtime graph.
      const runtimePath = join(uiDir, 'sources/theme/profiles/themeProfileRuntime.ts');
      const runtimeSource = ts.createSourceFile(runtimePath, readFileSync(runtimePath, 'utf8'), ts.ScriptTarget.Latest, true);
      const adapterType = runtimeSource.statements.find((statement) => ts.isTypeAliasDeclaration(statement)
        && statement.name.text === 'ThemeRuntimeUnistylesAdapter');
      const adapter = runtimeSource.statements.filter(ts.isVariableStatement)
        .flatMap((statement) => [...statement.declarationList.declarations])
        .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'defaultUnistylesRuntimeAdapter');
      const getTheme = adapter.initializer.properties.find((property) => property.name.getText(runtimeSource) === 'getTheme');
      write('sources/adapter.ts', "import { UnistylesRuntime } from 'react-native-unistyles'; import type { Theme } from './theme';\n"
        + "type AppThemeName = 'light' | 'dark';\n" + adapterType.getText(runtimeSource)
        + "\nexport const adapter: Pick<ThemeRuntimeUnistylesAdapter, 'getTheme'> = { " + getTheme.getText(runtimeSource) + ' };\n');
      const consumer = "import { StyleSheet, UnistylesRuntime, type UnistylesThemes, type UnistylesBreakpoints } from 'react-native-unistyles';\n"
        + "import { adapter } from './adapter'; export const color: string = adapter.getTheme('light').colors.surface.base;\n"
        + "export const styles = StyleSheet.create(theme => ({ root: { backgroundColor: theme.colors.surface.base } }));\n"
        + "export const light: keyof UnistylesThemes = 'light'; export const dark: keyof UnistylesThemes = 'dark';\n"
        + "export const lg: UnistylesBreakpoints['lg'] = 800; UnistylesRuntime.setTheme(light);\n";
      write('sources/consumer.ts', consumer);
      const green = run();
      assert.equal(green.status, 0, green.stdout + green.stderr);
      write('sources/consumer.ts', consumer + "export const unsupported: keyof UnistylesThemes = 'unknown'; adapter.getTheme('unknown');\n");
      const invalidTheme = run();
      assert.notEqual(invalidTheme.status, 0);
      assert.match(invalidTheme.stdout + invalidTheme.stderr, /consumer\.ts.*TS2322/u);
      assert.match(invalidTheme.stdout + invalidTheme.stderr, /consumer\.ts.*TS2345/u);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
}

test('CLI projects preserve every original root and compiler strictness', async () => {
  const packageDir = resolve('apps/cli');
  const sourceNames = ['tsconfig.foundation.json', 'tsconfig.services.json', 'tsconfig.core.json', 'tsconfig.source.json'];
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const args = pkg.scripts['typecheck:source:finite'].trim().split(/\s+/u);
  assert.deepEqual(args.filter((arg, index) => ['--project', '-p'].includes(args[index - 1])),
    [...sourceNames, 'tsconfig.test.json'], 'public CLI compiler must release each source partition before checking its consumer');
  const { prepareCliTypecheckProjects } = await import('../../../apps/cli/scripts/deriveTypecheckProjects.mjs');
  const inventory = await prepareCliTypecheckProjects([...sourceNames, 'tsconfig.test.json'].map(project => ({ project })), packageDir);
  const derivedSources = inventory.slice(0, sourceNames.length).map(({ configPath }) => relative(packageDir, configPath));
  const derivedTests = inventory.slice(sourceNames.length).map(({ configPath }) => relative(packageDir, configPath));
  assertProjectCoverage(packageDir, derivedSources, derivedTests, ['../ui/tsconfig.source.json']);
  const original = readProject('tsconfig.json', packageDir);
  const sources = derivedSources.map((name) => readProject(name, packageDir));
  const tests = readProject(derivedTests[0], packageDir);
  const isTest = (path) => /\.(?:test|spec)\.tsx?$/u.test(path)
    || path.replaceAll('\\', '/').includes('/__tests__/');
  assert.equal(original.fileNames.some(isTest), true, 'inherited CLI project must contain test roots');
  assert.equal(sources.some((source) => source.fileNames.some(isTest)), false, 'CLI source must not declaration-emit test roots');
  for (const file of original.fileNames.filter(isTest)) {
    assert.ok(tests.fileNames.includes(file), `CLI test project lost ${file}`);
  }
  assert.equal(new Set([...sources, tests].map((project) => project.options.tsBuildInfoFile)).size, 5);
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: packageDir });
  const inputs = spawnSync(invocation.command, [...invocation.argsPrefix,
    ...derivedSources.flatMap((name) => ['--project', join(packageDir, name)]), '--listFilesOnly'],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(inputs.status, 0, inputs.stdout + inputs.stderr);
  const roots = new Set(sources.flatMap((source) => source.fileNames.map((file) => resolve(file))));
  const unlisted = inputs.stdout.trim().split(/\r?\n/u).map((file) => resolve(file.trim()))
    .filter((file) => /\.[cm]?tsx?$/u.test(file) && !/\.d\.[cm]?ts$/u.test(file) && !roots.has(file));
  assert.deepEqual(unlisted, [],
    'CLI source must explicitly own every authored source it declaration-emits');
});

function assertNativeProjectBoundary(packageDir) {
  const sourceConfig = ts.readConfigFile(join(packageDir, 'tsconfig.source.json'), ts.sys.readFile).config;
  const testConfig = ts.readConfigFile(join(packageDir, 'tsconfig.test.json'), ts.sys.readFile).config;
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const publicArgs = pkg.scripts['typecheck:source:finite'].trim().split(/\s+/u);
  const sourceNames = publicArgs.filter((arg, index) => publicArgs[index - 1] === '--project' && arg !== 'tsconfig.test.json');
  const precedingNames = sourceNames.filter((name) => name !== 'tsconfig.source.json');
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-ui-typecheck-'));
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: packageDir });
  const run = (project, extra = []) => spawnSync(invocation.command,
    [...invocation.argsPrefix, '--project', join(fixtureDir, project), '--pretty', 'false', ...extra],
    { encoding: 'utf8', cwd: fixtureDir });
  try {
    const options = { types: [], paths: { '@/*': ['./sources/*'] }, rootDir: '.' };
    write('tsconfig.json', JSON.stringify({ extends: join(packageDir, 'tsconfig.json'), compilerOptions: options,
      include: ['sources/**/*.ts', 'stage/**/*.ts'], exclude: ['sources/trash/**'] }));
    for (const [index, name] of precedingNames.entries()) {
      const label = name.slice('tsconfig.'.length, -'.json'.length);
      const previous = precedingNames[index - 1]?.slice('tsconfig.'.length, -'.json'.length);
      write(`stage/${label}.ts`, previous
        ? `import { value } from './${previous}'; export const valueAtStage: string = value; export { value };\n`
        : "export const value: string = 'checked';\n");
      write(name, JSON.stringify({
        extends: join(packageDir, 'tsconfig.json'),
        compilerOptions: { ...options, ...sourceConfig.compilerOptions, rootDir: '.',
          outDir: `./cache/${label}`, tsBuildInfoFile: `./cache/${label}.tsbuildinfo` },
        references: precedingNames.slice(0, index).map((path) => ({ path: `./${path}` })),
        files: [`stage/${label}.ts`], include: [],
      }));
      const green = run(name);
      assert.equal(green.status, 0, green.stdout + green.stderr);
    }
    write('tsconfig.source.json', JSON.stringify({
      extends: join(packageDir, 'tsconfig.json'),
      compilerOptions: { ...options, ...sourceConfig.compilerOptions,
        rootDir: '.', outDir: './cache/source', tsBuildInfoFile: './cache/source.tsbuildinfo' },
      files: ['node_modules/fixture-native-package/src/index.ts'],
      references: precedingNames.map((path) => ({ path: `./${path}` })),
      include: ['sources/**/*.ts', 'external/**/*.ts', 'external/**/*.json'], exclude: ['**/*.test.ts'],
    }));
    write('tsconfig.test.json', JSON.stringify({
      extends: join(packageDir, 'tsconfig.json'),
      compilerOptions: { ...options, ...testConfig.compilerOptions,
        rootDir: '.', tsBuildInfoFile: './cache/test.tsbuildinfo' },
      references: [{ path: './tsconfig.source.json' }],
      include: ['sources/**/*.test.ts', 'sources/**/*.d.ts'],
    }));
    write('external/value.ts', "export const label = 'ok';\n");
    write('external/value.json', '{"enabled":true}');
    // Several installed UI packages expose authored TypeScript as their types.
    // Direct test imports must consume the same declaration boundary as UI code.
    write('node_modules/fixture-native-package/package.json', JSON.stringify({
      name: 'fixture-native-package', types: './src/index.ts',
    }));
    write('node_modules/fixture-native-package/src/index.ts', "export const dependencyLabel: string = 'dependency';\n");
    write('sources/model.ts', 'export interface Model { label: string }; export const model: Model = { label: 42 };\n');
    write('sources/augment.d.ts', "import './model'; declare module './model' { interface Model { enabled?: boolean } }\n");
    write('sources/model.test.ts', "import { model, type Model } from '@/model'; const valid: Model = { label: 'ok', enabled: true }; const label: string = model.label;\n");
    const sourceRed = run('tsconfig.source.json');
    assert.notEqual(sourceRed.status, 0);
    assert.match(sourceRed.stdout + sourceRed.stderr, /model\.ts.*TS2322/u);
    write('sources/model.ts', "import { label } from '../external/value'; import flags from '../external/value.json'; import { dependencyLabel } from 'fixture-native-package'; export interface Model { label: string }; export const model: Model = { label }; export const enabled = flags.enabled; export const dependency = dependencyLabel;\n");
    const sourceGreen = run('tsconfig.source.json');
    assert.equal(sourceGreen.status, 0, sourceGreen.stdout + sourceGreen.stderr);
    write('sources/model.test.ts', "import { model, type Model } from '@/model'; const valid: Model = { label: 'ok', enabled: true }; const label: number = model.label;\n");
    const testRed = run('tsconfig.test.json');
    assert.notEqual(testRed.status, 0);
    assert.match(testRed.stdout + testRed.stderr, /model\.test\.ts.*TS2322/u);
    write('sources/model.test.ts', "import { model, type Model } from '@/model'; import { dependencyLabel } from 'fixture-native-package'; const valid: Model = { label: 'ok', enabled: true }; const label: string = model.label; const dependency: string = dependencyLabel;\n");
    const testGreen = run('tsconfig.test.json', ['--listFiles']);
    assert.equal(testGreen.status, 0, testGreen.stdout + testGreen.stderr);
    const files = testGreen.stdout.split(/\r?\n/u).map((file) => resolve(file.trim()));
    assert.ok(files.includes(join(fixtureDir, 'cache/source/sources/model.d.ts')));
    assert.ok(files.includes(join(fixtureDir, 'sources/augment.d.ts')));
    assert.ok(!files.includes(join(fixtureDir, 'sources/model.ts')));
    assert.ok(!files.includes(join(fixtureDir, 'external/value.ts')));
    assert.ok(!files.includes(join(fixtureDir, 'node_modules/fixture-native-package/src/index.ts')),
      'authored dependency TypeScript must not be checked in both projects');
    const publicCompiler = publicFiniteCompiler(packageDir, fixtureDir, write, invocation);
    assert.deepEqual(publicCompiler.projects, [...sourceNames, 'tsconfig.test.json']);
    write('sources/model.ts', 'export interface Model { label: string }; export const model: Model = { label: 42 };\n');
    write('sources/model.test.ts', "import { model, type Model } from '@/model'; const valid: Model = { label: 'ok', enabled: true }; const label: number = model.label;\n");
    const publicRed = publicCompiler.run();
    assert.notEqual(publicRed.status, 0);
    assert.match(publicRed.stdout + publicRed.stderr, /model\.ts.*TS2322/u);
    assert.match(publicRed.stdout + publicRed.stderr, /model\.test\.ts.*TS2322/u);
    write('sources/model.ts', "import { label } from '../external/value'; import flags from '../external/value.json'; import { dependencyLabel } from 'fixture-native-package'; export interface Model { label: string }; export const model: Model = { label }; export const enabled = flags.enabled; export const dependency = dependencyLabel;\n");
    write('sources/model.test.ts', "import { model, type Model } from '@/model'; import { dependencyLabel } from 'fixture-native-package'; const valid: Model = { label: 'ok', enabled: true }; const label: string = model.label; const dependency: string = dependencyLabel;\n");
    write('compiler-spawns.jsonl', '');
    const measured = publicCompiler.run();
    assert.equal(measured.status, 0, measured.stdout + measured.stderr);
    const derivedProjects = publicCompiler.projects.map(project => join(fixtureDir, 'node_modules/.cache/tsc', project));
    assertOneCheckerInvocations(publicCompiler.nativeCalls(),
      derivedProjects);
    if (process.platform === 'linux') {
      const reports = measured.stderr.split('\n').filter((line) => line.startsWith('[typescript] {'))
        .map((line) => JSON.parse(line.slice('[typescript] '.length)));
      assert.deepEqual(reports.map(({ project, status, signal }) => ({ project, status, signal })),
        derivedProjects.map(project => ({ project, status: 0, signal: null })));
      assert.ok(reports.every(({ maxRssKiB }) => maxRssKiB > 0));
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

test('native UI projects redirect direct and transitive imports across the complete serial boundary', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'happier-ui-transitive-'));
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: uiDir, admissionClass: 'validation' });
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  const run = (name, extra = []) => spawnSync(invocation.command,
    [...invocation.argsPrefix, '--project', join(fixtureDir, `tsconfig.${name}.json`),
      '--pretty', 'false', ...extra], { encoding: 'utf8', cwd: fixtureDir });
  try {
    const names = ['foundation', 'core', 'source', 'test-components', 'test-other'];
    const moduleDeclaration = 'sources/activity/adapters/desktop/runtime/desktopActivityOverlayQaFixtures.d.ts';
    const downstreamImplementation = 'sources/activity/adapters/desktop/runtime/desktopActivityOverlayBridge.ts';
    const files = { foundation: ['foundation.ts', 'flags.json', 'sources/theme.ts'], core: ['left.ts', 'right.ts', downstreamImplementation],
      source: ['entry.ts'], 'test-components': ['sources/components/entry.test.ts'], 'test-other': ['sources/dev/entry.spec.ts'] };
    const commonTestOptions = ts.readConfigFile(join(uiDir, 'tsconfig.test.json'), ts.sys.readFile).config.compilerOptions;
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      const actual = ts.readConfigFile(join(uiDir, `tsconfig.${name}.json`), ts.sys.readFile).config;
      write(`tsconfig.${name}.json`, JSON.stringify({
        extends: join(uiDir, 'tsconfig.json'),
        compilerOptions: { ...(name.startsWith('test-') ? commonTestOptions : {}), ...actual.compilerOptions, types: [], paths: {
          'react-native-unistyles': ['./node_modules/fixture-unistyles/index.d.ts'],
          '@/theme': ['./sources/theme.ts'],
        }, rootDir: '.',
          outDir: `./cache/${name}`, tsBuildInfoFile: `./cache/${name}.tsbuildinfo` },
        ...(index ? { references: [{ path: `./tsconfig.${name.startsWith('test-') ? 'source' : names[index - 1]}.json` }] } : {}),
        files: [...files[name], 'ambient.d.ts', 'sources/types/unistyles.d.ts'],
        include: name === 'foundation' || name === 'core' ? actual.include
          : name === 'source' ? [moduleDeclaration] : actual.include,
        exclude: name.startsWith('test-') ? actual.exclude : [],
      }));
    }
    write('ambient.d.ts', 'declare const fixtureAmbient: string;\n');
    write('node_modules/fixture-unistyles/index.d.ts', 'export interface UnistylesThemes {}\n');
    // Shared augmentation must be present even before downstream runtime setup
    // entrypoints are compiled, without importing those implementations.
    write('sources/types/unistyles.d.ts', readFileSync(join(uiDir, 'sources/types/unistyles.d.ts'), 'utf8'));
    write('sources/theme.ts', 'export interface Theme { colors: { primary: string } }\n');
    // A module declaration belongs to the downstream source project, not the
    // shared ambient roots: its type import must not pull core into foundation.
    write(moduleDeclaration, "import type { bridge } from './desktopActivityOverlayBridge'; export declare const fixtureBridge: typeof bridge;\n");
    write(downstreamImplementation, "export { left as bridge } from '../../../../../left';\n");
    write('flags.json', '{"enabled":true}');
    write('foundation.ts', "import flags from './flags.json'; import type { UnistylesThemes } from 'react-native-unistyles'; type Theme = UnistylesThemes[keyof UnistylesThemes]; export const label: string = 'ok'; export const enabled = flags.enabled; export function themeColor(theme: Theme): string { return theme.colors.primary; }\n");
    write('left.ts', "import { label } from './foundation'; import { right } from './right'; export function left(): string { return label + right; }\n");
    write('right.ts', "import { left } from './left'; export const right: number = 'bad'; export const invoke = () => left();\n");
    write('entry.ts', "import { left } from './left'; import { label } from './foundation'; import { fixtureBridge } from './sources/activity/adapters/desktop/runtime/desktopActivityOverlayQaFixtures'; export const value = left() + label + fixtureAmbient + fixtureBridge();\n");
    const testInputs = {
      'test-components': ['sources/components/entry.test.ts', "import { value } from '../../entry'; import { left } from '../../left'; import { label } from '../../foundation'; const result: string = value + left() + label;\n"],
      'test-other': ['sources/dev/entry.spec.ts', "import { value } from '../../entry'; import { left } from '../../left'; import { label } from '../../foundation'; const result: string = value + left() + label;\n"],
    };
    for (const [file, content] of Object.values(testInputs)) write(file, content);
    write('sources/trash/ignored.test.ts', 'export const ignored: number = "bad";\n');
    write('node_modules/ignored/fixture.spec.ts', 'export const ignored: number = "bad";\n');
    const foundation = run('foundation');
    assert.equal(foundation.status, 0, foundation.stdout + foundation.stderr);
    const foundationText = readFileSync(join(fixtureDir, 'foundation.ts'), 'utf8');
    write('foundation.ts', foundationText.replace('themeColor(theme: Theme): string', 'themeColor(theme: Theme): number'));
    const themeRed = run('foundation');
    assert.notEqual(themeRed.status, 0, themeRed.stdout + themeRed.stderr);
    assert.match(themeRed.stdout + themeRed.stderr, /foundation\.ts.*TS2322/u);
    write('foundation.ts', foundationText);
    const themeGreen = run('foundation');
    assert.equal(themeGreen.status, 0, themeGreen.stdout + themeGreen.stderr);
    const coreRed = run('core');
    assert.notEqual(coreRed.status, 0);
    assert.match(coreRed.stdout + coreRed.stderr, /right\.ts.*TS2322/u);
    write('right.ts', "import { left } from './left'; export const right: string = 'ok'; export const invoke = () => left();\n");
    for (const name of ['core', 'source']) {
      const green = run(name, ['--listFiles']);
      assert.equal(green.status, 0, green.stdout + green.stderr);
      const inputs = green.stdout.split(/\r?\n/u).map((file) => resolve(file.trim()));
      assert.ok(inputs.includes(join(fixtureDir, 'cache/foundation/foundation.d.ts')));
      assert.ok(!inputs.includes(join(fixtureDir, 'foundation.ts')));
      if (name === 'source') {
        assert.ok(inputs.includes(join(fixtureDir, 'cache/core/left.d.ts')));
        assert.ok(!inputs.includes(join(fixtureDir, 'left.ts')));
      }
    }
    for (const [name, [file, content]] of Object.entries(testInputs)) {
      write(file, content.replace('result: string', 'result: number'));
      const testRed = run(name);
      assert.notEqual(testRed.status, 0);
      assert.match(testRed.stdout + testRed.stderr, /entry\.(?:test|spec)\.ts.*TS2322/u);
      write(file, content);
    }
    const publicCompiler = publicFiniteCompiler(uiDir, fixtureDir, write, invocation);
    assert.deepEqual(publicCompiler.projects, names.map((name) => `tsconfig.${name}.json`));
    write('right.ts', "import { left } from './left'; export const right: number = 'bad'; export const invoke = () => left();\n");
    for (const [file, content] of Object.values(testInputs)) write(file, content.replace('result: string', 'result: number'));
    const publicRed = publicCompiler.run();
    assert.notEqual(publicRed.status, 0);
    assert.match(publicRed.stdout + publicRed.stderr, /right\.ts.*TS2322/u);
    assert.match(publicRed.stdout + publicRed.stderr, /entry\.test\.ts.*TS2322/u);
    assert.match(publicRed.stdout + publicRed.stderr, /entry\.spec\.ts.*TS2322/u);
    write('right.ts', "import { left } from './left'; export const right: string = 'ok'; export const invoke = () => left();\n");
    for (const [file, content] of Object.values(testInputs)) write(file, content);
    write('compiler-spawns.jsonl', '');
    const serial = publicCompiler.run();
    assert.equal(serial.status, 0, serial.stdout + serial.stderr);
    assertOneCheckerInvocations(publicCompiler.nativeCalls(),
      publicCompiler.projects.map((project) => join(fixtureDir, project)));
    for (const [testName, [testFile]] of Object.entries(testInputs)) {
      const testGreen = run(testName, ['--listFiles']);
      assert.equal(testGreen.status, 0, testGreen.stdout + testGreen.stderr);
      const inputs = testGreen.stdout.split(/\r?\n/u).map((file) => resolve(file.trim()));
      assert.ok(inputs.includes(join(fixtureDir, testFile)));
      assert.ok(inputs.includes(join(fixtureDir, 'ambient.d.ts')));
      assert.ok(!inputs.includes(join(fixtureDir, 'sources/trash/ignored.test.ts')));
      assert.ok(!inputs.includes(join(fixtureDir, 'node_modules/ignored/fixture.spec.ts')));
      for (const [otherName, [otherFile]] of Object.entries(testInputs)) {
        if (testName !== otherName) assert.ok(!inputs.includes(join(fixtureDir, otherFile)));
      }
      for (const [name, file] of [['foundation', 'foundation'], ['core', 'left'], ['source', 'entry']]) {
        assert.ok(inputs.includes(join(fixtureDir, `cache/${name}/${file}.d.ts`)));
        assert.ok(!inputs.includes(join(fixtureDir, `${file}.ts`)));
      }
    }
    if (process.platform === 'linux') {
      const reports = serial.stderr.split('\n').filter((line) => line.startsWith('[typescript] {'))
        .map((line) => JSON.parse(line.slice('[typescript] '.length)));
      assert.deepEqual(reports.map(({ project }) => project),
        names.map((name) => join(fixtureDir, `tsconfig.${name}.json`)));
      assert.ok(reports.every(({ maxRssKiB, status }) => maxRssKiB > 0 && status === 0));
    }
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('native UI serial checker derives added and removed files while preserving real diagnostics', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'happier-ui-derived-'));
  const fixtureDir = join(fixtureRoot, 'apps/ui');
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  try {
    mkdirSync(fixtureDir, { recursive: true });
    const admission = await installNativeAdmissionFixture({ root: fixtureDir });
    // This tiny native program has an isolated OS memory/admission fixture;
    // compiler selection, native checking and process custody stay real.
    write('bin/awk', '#!/bin/sh\ncase "$*" in\n*/proc/meminfo*) printf "67108864 100663296\\n" ;;\n*/proc/loadavg*|*/proc/pressure/*) printf "0\\n" ;;\n*) exec /usr/bin/awk "$@" ;;\nesac\n');
    chmodSync(join(fixtureDir, 'bin/awk'), 0o755);
    write('package.json', JSON.stringify({ name: 'ui-compiler-input-fixture' }));
    write('app.json', JSON.stringify({ expo: { name: 'Compiler inputs', slug: 'compiler-inputs', experiments: { typedRoutes: false } } }));
    mkdirSync(join(fixtureDir, 'node_modules'), { recursive: true });
    symlinkSync(join(uiDir, 'node_modules/expo'), join(fixtureDir, 'node_modules/expo'), process.platform === 'win32' ? 'junction' : 'dir');
    write('tsconfig.json', JSON.stringify({ extends: join(uiDir, 'tsconfig.json'),
      compilerOptions: { types: [], paths: {} }, include: ['*.ts'], exclude: ['cache', 'node_modules'] }));
    const names = ['foundation', 'core', 'source', 'test-components', 'test-other'];
    const commonTestOptions = readProject('tsconfig.test.json').raw.compilerOptions;
    const files = [['base.ts'], ['left.ts', 'right.ts'], ['entry.ts'], [], ['entry.test.ts']];
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      const actual = readProject(`tsconfig.${name}.json`).raw;
      write(`tsconfig.${name}.json`, JSON.stringify({ extends: './tsconfig.json',
        compilerOptions: { ...(name.startsWith('test-') ? commonTestOptions : {}), ...actual.compilerOptions, rootDir: '.',
          outDir: `./cache/${name}`, tsBuildInfoFile: `./cache/${name}.tsbuildinfo` },
        ...(index ? { references: [{ path: `./tsconfig.${name.startsWith('test-') ? 'source' : names[index - 1]}.json` }] } : {}),
        files: files[index], include: [], exclude: [] }));
    }
    write('tsconfig.test.json', JSON.stringify({ extends: './tsconfig.json', compilerOptions: commonTestOptions,
      files: ['entry.test.ts'], include: [], references: [{ path: './tsconfig.source.json' }] }));
    write('base.ts', "export { added } from './added';\n");
    write('added.ts', 'export const added: string = "new";\n');
    write('left.ts', "import { added } from './base'; import { right } from './right'; export const left = (): string => added + right();\n");
    write('right.ts', "import { left } from './left'; export const right = (): string => left();\n");
    write('entry.ts', "export { left } from './left';\n");
    write('entry.test.ts', "import { left } from './entry'; const result: string = left();\n");
    write('uiAmbient.d.ts', 'interface CliEnvironment { UI_ONLY: string }\n');
    const invocation = resolveTypeScriptCliInvocation({ env: { CI: 'true' } });
    const compiler = publicFiniteCompiler(uiDir, fixtureDir, write, invocation, admission);
    const authoredConfigs = names.map(name => readFileSync(join(fixtureDir, `tsconfig.${name}.json`), 'utf8'));
    const added = compiler.run();
    assert.equal(added.status, 0, added.stdout + added.stderr);
    assert.deepEqual(names.map(name => readFileSync(join(fixtureDir, `tsconfig.${name}.json`), 'utf8')), authoredConfigs,
      'the public runner must admit new roots without rewriting authored compiler configs');
    rmSync(join(fixtureDir, 'cache/foundation'), { recursive: true, force: true });
    const rebuilt = compiler.run();
    assert.equal(rebuilt.status, 0, rebuilt.stdout + rebuilt.stderr);
    assert.ok(readFileSync(join(fixtureDir, 'cache/foundation/base.d.ts'), 'utf8').includes('added'),
      'missing declaration outputs must regenerate despite retained incremental metadata');
    // A rename removes an old generated root and discovers the replacement.
    rmSync(join(fixtureDir, 'added.ts'));
    write('replacement.ts', 'export const added: string = "moved";\n');
    write('base.ts', "export { added } from './replacement';\n");
    const moved = compiler.run();
    assert.equal(moved.status, 0, moved.stdout + moved.stderr);
    write('replacement.ts', 'export const added: string = 42;\n');
    write('entry.test.ts', "import { left } from './entry'; const result: number = left();\n");
    const invalid = compiler.run();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout + invalid.stderr, /replacement\.ts.*TS2322/);
    assert.match(invalid.stdout + invalid.stderr, /entry\.test\.ts.*TS2322/);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /TS6307|TS6053/);
    assert.deepEqual(names.map(name => readFileSync(join(fixtureDir, `tsconfig.${name}.json`), 'utf8')), authoredConfigs);
    // A CLI consumer keeps all its own roots, but references UI declarations
    // instead of importing the UI project's production-only globals.
    write('replacement.ts', 'export const added: string = "restored";\n');
    write('entry.test.ts', "import { left } from './entry'; const result: string = left();\n");
    const cliDir = join(fixtureRoot, 'apps/cli');
    const writeCli = (file, value) => {
      mkdirSync(dirname(join(cliDir, file)), { recursive: true });
      writeFileSync(join(cliDir, file), value);
    };
    writeCli('tsconfig.json', JSON.stringify({ compilerOptions: {
      strict: true, types: [], target: 'es2022', module: 'esnext', moduleResolution: 'bundler',
    }, files: ['cli.ts', 'consumer.test.ts', 'neighbor.test.ts', 'cliAmbient.d.ts'] }));
    const cliCompiler = publicFiniteCompiler(resolve('apps/cli'), cliDir, writeCli, invocation, admission);
    const cliSources = cliCompiler.projects.filter(name => name !== 'tsconfig.test.json');
    for (const [index, name] of cliSources.entries()) {
      const actual = readProject(name, resolve('apps/cli')).raw;
      const label = name.slice('tsconfig.'.length, -'.json'.length);
      writeCli(name, JSON.stringify({ extends: './tsconfig.json',
        compilerOptions: { ...actual.compilerOptions, rootDir: '.', outDir: `./cache/${label}`,
          tsBuildInfoFile: `./cache/${label}.tsbuildinfo` },
        files: ['cli.ts', 'cliAmbient.d.ts'], include: [],
        references: cliSources.slice(0, index).map(path => ({ path: `./${path}` })) }));
    }
    writeCli('tsconfig.test.json', JSON.stringify({ extends: './tsconfig.json',
      compilerOptions: { noEmit: true, disableSourceOfProjectReferenceRedirect: true },
      files: ['consumer.test.ts', 'neighbor.test.ts', 'cliAmbient.d.ts'],
      references: [{ path: './tsconfig.source.json' }, { path: '../ui/tsconfig.source.json' }] }));
    writeCli('cli.ts', 'export const cli = true;\n');
    writeCli('cliAmbient.d.ts', 'interface CliEnvironment {}\n');
    writeCli('consumer.test.ts', "import { left } from '../ui/entry'; export const value: string = left(); const env: CliEnvironment = {};\n");
    writeCli('neighbor.test.ts', 'export const neighbor: boolean = true;\n');
    // The admission fixture's PATH is shared by these two tiny real compilers.
    mkdirSync(join(cliDir, 'bin'));
    symlinkSync(join(fixtureDir, 'bin/awk'), join(cliDir, 'bin/awk'));
    const cli = cliCompiler.run(['--listFiles']);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    const loaded = cli.stdout.trim().split(/\r?\n/u).map(file => resolve(file.trim()));
    assert.ok(loaded.includes(join(cliDir, 'consumer.test.ts')) && loaded.includes(join(cliDir, 'neighbor.test.ts')));
    assert.ok(loaded.includes(join(fixtureDir, 'cache/source/entry.d.ts')));
    assert.ok(!loaded.includes(join(fixtureDir, 'entry.ts')) && !loaded.includes(join(fixtureDir, 'uiAmbient.d.ts')),
      'the CLI consumer must not recheck UI implementations or import UI globals');
    writeCli('neighbor.test.ts', 'export const neighbor: boolean = 42;\n');
    const cliInvalid = cliCompiler.run();
    assert.notEqual(cliInvalid.status, 0);
    assert.match(cliInvalid.stdout + cliInvalid.stderr, /neighbor\.test\.ts.*TS2322/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('native CLI project boundary checks source and test types without rechecking source implementations', () => {
  assertNativeProjectBoundary(resolve('apps/cli'));
});

test('native test-package checker keeps source, suite and configuration semantic coverage with one checker', () => {
  const packageDir = resolve('packages/tests');
  const actual = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile).config;
  const cacheDir = resolve('node_modules/.cache');
  mkdirSync(cacheDir, { recursive: true });
  const fixtureDir = mkdtempSync(join(cacheDir, 'happier-tests-typecheck-'));
  const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: packageDir });
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  try {
    write('tsconfig.json', JSON.stringify({
      ...actual,
      compilerOptions: { ...actual.compilerOptions, types: [], paths: {},
        tsBuildInfoFile: './cache/tests.tsbuildinfo' },
    }));
    write('src/model.ts', "export const label: string = 'ok';\n");
    write('src/environment.d.ts', 'declare const fixtureEnvironment: string;\n');
    write('suites/model.test.ts', "import { label } from '../src/model'; export const value: string = label + fixtureEnvironment;\n");
    write('scripts/environment.d.mts', 'declare const fixtureScriptEnvironment: string;\n');
    write('vitest.fixture.ts', 'export const label: string = fixtureScriptEnvironment;\n');
    const publicCompiler = publicFiniteCompiler(packageDir, fixtureDir, write, invocation);
    assert.deepEqual(publicCompiler.projects, ['tsconfig.json']);
    const green = publicCompiler.run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    for (const [file, content] of [
      ['src/model.ts', 'export const label: string = 42;\n'],
      ['suites/model.test.ts', "import { label } from '../src/model'; export const value: number = label + fixtureEnvironment;\n"],
      ['vitest.fixture.ts', 'export const label: number = fixtureScriptEnvironment;\n'],
    ]) {
      const original = readFileSync(join(fixtureDir, file), 'utf8');
      write(file, content);
      const red = publicCompiler.run();
      assert.notEqual(red.status, 0, file);
      assert.match(red.stdout + red.stderr, new RegExp(`${file.replaceAll('.', '\\.')}.*TS2322`, 'u'));
      write(file, original);
    }
    const restored = publicCompiler.run();
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assertOneCheckerInvocations(publicCompiler.nativeCalls().slice(-1), [join(fixtureDir, 'tsconfig.json')]);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('native UI configuration resolver compiles outside the derived CLI runtime partitions', async () => {
  const packageDir = resolve('apps/cli');
  const actual = ts.readConfigFile(join(packageDir, 'tsconfig.source.json'), ts.sys.readFile).config;
  const { deriveCliTypecheckProjects } = await import('../../../apps/cli/scripts/deriveTypecheckProjects.mjs');
  const inventory = await deriveCliTypecheckProjects(packageDir);
  const resolverPath = resolve('scripts/testing/vitestWorkspacePackageResolution.ts');
  const sourceProjects = inventory.filter(({ project }) => project !== 'test');
  const owners = sourceProjects.filter(({ configPath }) =>
    JSON.parse(readFileSync(configPath, 'utf8')).files.includes(resolverPath));
  assert.equal(readProject('tsconfig.json', packageDir).fileNames.includes(resolve('apps/ui/vitest.config.ts')), false,
    'UI test configuration is outside the CLI editor/runtime roots');
  assert.equal(owners.length, 0, 'the derived runtime graph must not gain a test-configuration root');
  const cacheDir = resolve('node_modules/.cache');
  mkdirSync(cacheDir, { recursive: true });
  const fixtureDir = mkdtempSync(join(cacheDir, 'happier-cli-config-closure-'));
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  try {
    const uiConfig = ts.createSourceFile('vitest.config.ts', readFileSync(join(uiDir, 'vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const resolverImport = uiConfig.statements.find((statement) => ts.isImportDeclaration(statement)
      && statement.moduleSpecifier.text === '../../scripts/testing/vitestWorkspacePackageResolution');
    assert.ok(resolverImport, 'fixture must retain the real UI configuration import');
    write('apps/ui/vitest.config.ts', resolverImport.getText(uiConfig)
      + "\nexport const workspacePackages: readonly WorkspacePackageSpec[] = readBundledPluginWorkspacePackageSpecs('.');\n"
      + 'export const workspacePlugin = createWorkspacePackageSourcesPlugin(workspacePackages);\n');
    for (const file of ['scripts/testing/vitestWorkspacePackageResolution.ts', 'apps/cli/scripts/build-owned/bundledPluginMembership.ts']) {
      write(file, readFileSync(resolve(file), 'utf8'));
    }
    const closureFiles = ['../ui/vitest.config.ts', '../../scripts/testing/vitestWorkspacePackageResolution.ts',
      'scripts/build-owned/bundledPluginMembership.ts'];
    write('apps/cli/tsconfig.source.json', JSON.stringify({
      ...actual, extends: join(packageDir, 'tsconfig.json'),
      compilerOptions: { ...actual.compilerOptions, rootDir: '../..',
        outDir: '../../cache/source', tsBuildInfoFile: '../../cache/source.tsbuildinfo' },
      files: closureFiles, include: [], references: [],
    }));
    const { launcher } = await installNativeAdmissionFixture({ root: fixtureDir });
    const args = ['--singleThreaded', '--project', join(fixtureDir, 'apps/cli/tsconfig.source.json'), '--pretty', 'false'];
    const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), args });
    const result = spawnSync(invocation.command.endsWith('/apps/stack/bin/hstack-exec') ? launcher : invocation.command,
      [...invocation.argsPrefix, ...args], { encoding: 'utf8', cwd: fixtureDir });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('RNW source consumers compile module JSX with the Plugin UI producer contract', async () => {
  // Keep ordinary package dependency resolution: React types are owned by
  // this UI consumer, not by the repository's non-UI tooling package.
  const cacheDir = resolve('packages/plugins/channels/node_modules/.cache');
  mkdirSync(cacheDir, { recursive: true });
  const fixtureDir = mkdtempSync(join(cacheDir, 'happier-rnw-source-consumer-'));
  try {
    // Reproduce the imported presentation source: JSX in an ES module has no
    // global React binding. Use the consumer's actual compiler configuration.
    writeFileSync(join(fixtureDir, 'presentation.tsx'), 'export const panel = <div />;\n');
    writeFileSync(join(fixtureDir, 'consumer.ts'), "export { panel } from './presentation.js';\n");
    writeFileSync(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
      extends: resolve('packages/plugins/channels/tsconfig.tests.json'),
      compilerOptions: { rootDir: resolve('.'), types: ['node', 'react'] },
      files: ['consumer.ts', resolve('scripts/testing/vitestWorkspacePackageResolution.ts')],
      include: [], exclude: [],
    }));
    // Isolate only OS admission state using the same canonical boundary
    // fixture as neighboring native compiler tests; semantic checks stay real.
    const { launcher } = await installNativeAdmissionFixture({ root: fixtureDir });
    const args = ['--noEmit', '--project', join(fixtureDir, 'tsconfig.json'), '--pretty', 'false'];
    const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), args });
    const result = spawnSync(invocation.command.endsWith('/apps/stack/bin/hstack-exec') ? launcher : invocation.command,
      [...invocation.argsPrefix, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('native CLI compilation uses one SDK declaration identity across package roots and public subpaths', () => {
  const packageDir = resolve('apps/cli');
  const actual = ts.readConfigFile(join(packageDir, 'tsconfig.json'), ts.sys.readFile).config;
  const project = readProject('tsconfig.json', packageDir);
  const sdkDir = resolve('packages/plugin-sdk');
  const sdkPackage = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
  for (const [subpath, entry] of Object.entries(sdkPackage.exports)) {
    const specifier = '@happier-dev/plugin-sdk' + (subpath === '.' ? '' : subpath.slice(1));
    const module = ts.resolveModuleName(specifier, join(packageDir, 'src/index.ts'), project.options, ts.sys).resolvedModule;
    assert.equal(module?.resolvedFileName, resolve(sdkDir, entry.types),
      `CLI must preserve the public declaration owner for ${specifier}`);
  }
  const cacheDir = resolve('node_modules/.cache');
  mkdirSync(cacheDir, { recursive: true });
  const fixtureDir = mkdtempSync(join(cacheDir, 'happier-cli-sdk-identity-'));
  const write = (file, value) => {
    mkdirSync(dirname(join(fixtureDir, file)), { recursive: true });
    writeFileSync(join(fixtureDir, file), value);
  };
  try {
    // Packaging materializes a physical CLI dependency copy. Reproduce that OS
    // layout rather than relying on the development overlay's collapsing symlink.
    const sdkManifest = { name: '@happier-dev/plugin-sdk', version: '0.0.0', type: 'module',
      exports: { '.': { types: './dist/index.d.ts' }, './ui': { types: './dist/ui/index.d.ts' },
        './ui/client': { types: './dist/ui/client/index.d.ts' } } };
    const sdkApi = 'export interface PluginApi { label: string };\n';
    for (const root of ['apps/cli/node_modules/@happier-dev/plugin-sdk', 'packages/plugin-sdk']) {
      write(`${root}/package.json`, JSON.stringify(sdkManifest));
      write(`${root}/dist/index.d.ts`, sdkApi);
      write(`${root}/dist/ui/index.d.ts`, "export type { PluginApi } from '../index.js';\n");
      write(`${root}/dist/ui/client/index.d.ts`, "export type { PluginApi } from '../../index.js';\n");
    }
    write('apps/cli/tsconfig.json', JSON.stringify({
      extends: join(packageDir, 'tsconfig.json'),
      compilerOptions: { types: [], paths: actual.compilerOptions.paths, rootDir: '../..',
        tsBuildInfoFile: '../../cache/cli.tsbuildinfo' },
      files: ['src/consumer.ts'], include: [],
    }));
    const consumer = "import type { PluginApi } from '@happier-dev/plugin-sdk';\n"
      + "import type { PluginApi as UiApi } from '@happier-dev/plugin-sdk/ui';\n"
      + "import type { PluginApi as ClientApi } from '@happier-dev/plugin-sdk/ui/client';\n"
      + "import type { PluginApi as WorkspaceApi } from '../../../packages/plugin-sdk/dist/index';\n"
      + 'declare const workspace: WorkspaceApi; export const host: PluginApi = workspace;\n'
      + 'export const ui: UiApi = host; export const client: ClientApi = ui;\n';
    write('apps/cli/src/consumer.ts', consumer);
    const invocation = resolveTypeScriptCliInvocation({ repoRoot: resolve('.'), workspaceDir: packageDir });
    const run = () => spawnSync(invocation.command, [...invocation.argsPrefix, '--singleThreaded',
      '--project', join(fixtureDir, 'apps/cli/tsconfig.json'), '--pretty', 'false', '--listFiles'],
    { encoding: 'utf8', cwd: fixtureDir });
    const green = run();
    assert.equal(green.status, 0, green.stdout + green.stderr);
    const sdkFiles = green.stdout.split(/\r?\n/u).map((file) => resolve(file.trim()))
      .filter((file) => file.includes('plugin-sdk/dist/'));
    assert.deepEqual(sdkFiles.sort(), ['index.d.ts', 'ui/index.d.ts', 'ui/client/index.d.ts']
      .map((file) => join(fixtureDir, 'packages/plugin-sdk/dist', file)).sort(),
    'all SDK imports must consume the canonical workspace declarations once');
    write('apps/cli/src/consumer.ts', consumer + 'export const invalid: number = client.label;\n');
    const red = run();
    assert.notEqual(red.status, 0);
    assert.match(red.stdout + red.stderr, /consumer\.ts.*TS2322/u);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
