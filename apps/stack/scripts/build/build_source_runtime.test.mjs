import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, cp, mkdtemp, mkdir, writeFile, readFile, realpath, symlink, rm, access, readdir, stat } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSourceRuntimeBundle, captureSourceWebBuildInputs } from './build_source_runtime.mjs';
import { prepareSourceComponent } from '../utils/dev/devReloadCoordinator.mjs';
import { runSourceBuildCommand } from '../utils/proc/runSourceBuildCommand.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { installNativeAdmissionFixture } from '../testkit/core/native_admission_fixture.mjs';
import { runServerRuntimeMigration } from '../runtime/launch/runServerRuntimeMigration.mjs';
import { resolveServerRuntimeLaunchSpec } from '../runtime/launch/resolveServerRuntimeLaunchSpec.mjs';
import { matchesNativeTypeScriptInputVersion, resolveTypeScriptCliInvocation } from '../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { withWorkspaceBundleLock } from '../../../../packages/cli-common/workspaceBundleLock.mjs';

test('source web capture retains consumed publication policy and authored packaged brand bytes', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-web-build-closure-' });
  const repoDir = fixture.path('repo');
  await mkdir(repoDir);
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/plugins/*'] }));
  for (const name of ['cli', 'stack', 'ui']) {
    await mkdir(join(repoDir, 'apps', name, 'scripts'), { recursive: true });
    await writeFile(join(repoDir, 'apps', name, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`, type: 'module' }));
  }
  const publicationPath = 'apps/cli/scripts/buildPublication.mjs';
  const publicationSource = await readFile(new URL('../../../../' + publicationPath, import.meta.url), 'utf8');
  await writeFile(join(repoDir, publicationPath), publicationSource);
  await mkdir(join(repoDir, 'apps/cli/src'));
  await writeFile(join(repoDir, 'apps/cli/src/index.ts'), 'export const unrelatedCliSource = true;');
  const pluginRoot = join(repoDir, 'packages/plugins/fixture');
  await mkdir(join(pluginRoot, 'assets'), { recursive: true });
  await mkdir(join(pluginRoot, 'src'), { recursive: true });
  await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
    name: '@happier-dev/plugins-fixture', type: 'module', files: ['assets', '.happier-plugin'],
    exports: { './manifest': './src/plugin.mjs' },
  }));
  const manifest = {
    brand: { iconResourceId: 'brand-icon' },
    contributes: { resources: [{ id: 'brand-icon', kind: 'asset', contentType: 'image/png', path: 'assets/brand.png' }] },
  };
  await writeFile(join(pluginRoot, 'src/plugin.mjs'), `export const PLUGIN_MANIFEST = ${JSON.stringify(manifest)};`);
  await writeFile(join(pluginRoot, '.happier-plugin/plugin.json'), JSON.stringify(manifest));
  const brandBytes = new Uint8Array([137, 80, 78, 71]);
  await writeFile(join(pluginRoot, 'assets/brand.png'), brandBytes);
  await writeFile(join(pluginRoot, '.happier-plugin/daemon.js'), 'generated runtime output');
  const captured = await captureSourceWebBuildInputs({ repoDir, outputDir: fixture.path('capture') });
  assert.equal(await readFile(join(captured.repoDir, publicationPath), 'utf8'), publicationSource);
  const { resolveCliPublicationBuildSteps } = await import(pathToFileURL(join(captured.repoDir, publicationPath)));
  assert.deepEqual(resolveCliPublicationBuildSteps({ repoRoot: captured.repoDir }).map(step => step.name), ['shared-deps', 'dist']);
  await assert.rejects(access(join(captured.repoDir, 'apps/cli/src/index.ts')), { code: 'ENOENT' });
  const capturedPluginRoot = join(captured.repoDir, 'packages/plugins/fixture');
  const { PLUGIN_MANIFEST } = await import(pathToFileURL(join(capturedPluginRoot, 'src/plugin.mjs')));
  const resource = PLUGIN_MANIFEST.contributes.resources.find(entry => entry.id === PLUGIN_MANIFEST.brand.iconResourceId);
  assert.deepEqual(new Uint8Array(await readFile(join(capturedPluginRoot, resource.path))), brandBytes);
  await assert.rejects(access(join(capturedPluginRoot, '.happier-plugin/plugin.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(captured.repoDir, 'packages/plugins/fixture/.happier-plugin/daemon.js')), { code: 'ENOENT' });
});

async function linkCanonicalServerWorkspace(repoDir) {
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  // The real migration owner imports real workspace packages. Preserve that
  // source graph rather than replacing its internal dependencies with fixtures.
  for (const directory of ['packages', 'node_modules']) {
    await symlink(join(canonicalRepo, directory), join(repoDir, directory),
      process.platform === 'win32' ? 'junction' : 'dir');
  }
}

async function makeFixtureWritable(directory) {
  await chmod(directory, 0o755);
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    if (entry.isDirectory()) await makeFixtureWritable(join(directory, entry.name));
    else if (!entry.isSymbolicLink()) await chmod(join(directory, entry.name), 0o644);
  }
}

async function installSourcePreparationInputs(repoDir, component) {
  // Model the checkout inputs watched by the real preparation owner. Missing
  // fixture roots must not replace the source failure each test exercises.
  await mkdir(join(repoDir, 'scripts/workspaces'), { recursive: true });
  await mkdir(join(repoDir, 'apps/stack/scripts/build'), { recursive: true });
  if (!existsSync(join(repoDir, 'yarn.lock'))) await writeFile(join(repoDir, 'yarn.lock'), '');
  if (component !== 'daemon') return;
  await mkdir(join(repoDir, 'apps/ui/scripts'), { recursive: true });
  for (const [path, contents] of [
    ['apps/ui/package.json', JSON.stringify({ name: '@happier-dev/ui' })],
    ['apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs', ''],
    ['apps/ui/scripts/generateBundledPluginUiArtifacts.mjs', ''],
  ]) if (!existsSync(join(repoDir, path))) await writeFile(join(repoDir, path), contents);
}

async function installSourceAdmissionFixture(root) {
  const native = await installNativeAdmissionFixture({root});
  const adapterSource = new URL('../utils/proc/runSourceBuildCommand.mjs',import.meta.url);
  const adapter = join(root,'native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
  await writeFile(adapter,(await readFile(adapterSource,'utf8')).replace(
    "from '../dev/devReloadCoordinator.mjs'",`from ${JSON.stringify(new URL('../dev/devReloadCoordinator.mjs',adapterSource).href)}`));
  const runtimeSource = new URL('./build_source_runtime.mjs',import.meta.url);
  const runtimePath = join(root,'native-owner/apps/stack/scripts/build/build_source_runtime.mjs');
  await mkdir(dirname(runtimePath),{recursive:true});
  // Install the genuine owner beside the fixture's genuine native launcher.
  // Remap imports only, preserving real selection/build/retention decisions.
  await writeFile(runtimePath,(await readFile(runtimeSource,'utf8')).replace(/^((?:import|export) [^\n]*from )'(\.[^']+)'/gm,(match,prefix,path)=> {
    if(path==='../utils/proc/runSourceBuildCommand.mjs' || path==='../utils/proc/workspace_build_admission.mjs') return match;
    return `${prefix}${JSON.stringify(new URL(path,runtimeSource).href)}`;
  }));
  const {buildSourceRuntimeBundle:build} = await import(pathToFileURL(runtimePath));
  const {runSourceBuildCommand:runSourceCommand} = await import(pathToFileURL(adapter));
  await mkdir(join(root,'bin'));
  await writeFile(join(root,'bin/awk'),`#!/bin/sh\ncase "$*" in\n  */proc/meminfo*) printf '16777216 16777216\\n' ;;\n  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;\n  *) exec /usr/bin/awk "$@" ;;\nesac\n`);
  await chmod(join(root,'bin/awk'),0o755);
  const env = {...process.env,PATH:`${join(root,'bin')}:/usr/bin:/bin`,HAPPIER_DEV_TARGET_EXECUTION:'1'};
  for(const key of Object.keys(env)) if(key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_') || key.startsWith('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_')) delete env[key];
  return {...native,runtimePath,build,runSourceCommand,env};
}

test('source daemon stages current native custody source instead of borrowing stale checkout tools', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-native-custody-' });
  const repoDir = fixture.path('repo');
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const cliDir = join(repoDir, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'tools/unpacked'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = true;');
  for (const name of ['packages', 'node_modules']) await symlink(join(canonicalRepo, name), join(repoDir, name), process.platform === 'win32' ? 'junction' : 'dir');
  await cp(join(canonicalRepo, 'apps/cli/native/processcustody'), join(cliDir, 'native/processcustody'), { recursive: true });
  const name = `happier-process-custody${process.platform === 'win32' ? '.exe' : ''}`;
  const stale = join(cliDir, 'tools/unpacked', name);
  await writeFile(stale, 'stale helper lacking disk-measure');
  const built = await buildSourceRuntimeBundle({ repoDir, outputDir: fixture.path('runtime'), component: 'daemon' });
  const helper = join(built.runtimeDir, 'tools/unpacked', name);
  assert.notEqual(await realpath(helper), await realpath(stale));
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(helper, ['disk-measure'], (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify({ paths: [] }));
  });
  const measured = JSON.parse(stdout);
  assert.equal(measured.v, 1);
  assert.deepEqual(measured.perPath, []);
  assert.equal(await readFile(stale, 'utf8'), 'stale helper lacking disk-measure');
});

test('shared source daemon preparation rejoins joint admission after a queued launcher cutover',
  { skip: process.platform !== 'linux' }, async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-native-admission-', registerCleanup: false });
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root, { recursive: true, force: true }); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const repoDir = fixture.path('repo');
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const cliDir = join(repoDir, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = true;');
  await writeFile(join(repoDir, 'yarn.lock'), '');
  for (const name of ['packages', 'node_modules']) await symlink(join(canonicalRepo, name), join(repoDir, name), 'dir');
  await cp(join(canonicalRepo, 'apps/cli/native/processcustody'), join(cliDir, 'native/processcustody'), { recursive: true });
  await installSourcePreparationInputs(repoDir, 'daemon');
  const env = { ...native.env, PATH: `${native.env.PATH}:${process.env.PATH}` };
  const statePath = fixture.path('native-owner/apps/stack/scripts/utils/proc/native_host_admission_state.sh');
  const currentState = await readFile(statePath, 'utf8');
  const legacyRoot = fixture.path('legacy-admission');
  await writeFile(statePath, currentState.replace(native.admissionRoot, legacyRoot));
  const available = fixture.path('available-memory');
  const observed = fixture.path('memory-observed');
  await writeFile(available, '5242880');
  await writeFile(fixture.path('bin/awk'), `#!/bin/sh
case "$*" in
  */proc/meminfo*)
    available=$(/bin/cat '${available}')
    printf '%s 16777216\\n' "$available"
    [ "$available" -ne 5242880 ] || printf observed > '${observed}'
    ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
  const watcher = watch(fixture.root);
  context.after(() => watcher.close());
  const pressure = new Promise((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('change', (_event, name) => { if (name === 'memory-observed') { watcher.close(); resolve(); } });
  });
  await mkdir(native.admissionRoot, { recursive: true });
  const mutex = spawn('flock', [join(native.admissionRoot, 'lock'), process.execPath, '-e',
    'process.stdout.write("locked\\n"); process.stdin.resume();'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const mutexClosed = new Promise(resolve => mutex.once('close', resolve));
  context.after(async () => { mutex.stdin.end(); await mutexClosed; });
  await new Promise((resolve, reject) => { mutex.stdout.once('data', resolve); mutex.once('error', reject); });
  let diagnostic = '';
  const stderrWrite = process.stderr.write;
  process.stderr.write = function(chunk, ...args) {
    diagnostic += String(chunk);
    if (diagnostic.includes('HSTACK_WORKSPACE_ADMISSION_ORDER:')) mutex.stdin.end();
    return stderrWrite.call(this, chunk, ...args);
  };
  context.after(() => { process.stderr.write = stderrWrite; });
  const pending = native.build({ repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon', env, signal: context.signal });
  const completion = pending.then(built => ({ built }), error => ({ error }));
  await pressure;
  // The parent has parsed the old root while queued; its newly launched
  // preparation children read the current root and find its mutex occupied.
  await writeFile(statePath, currentState);
  await writeFile(available, '16777216');
  const outcome = await completion;
  assert.equal(outcome.error, undefined);
  assert.match(diagnostic, /HSTACK_WORKSPACE_ADMISSION_ORDER:/);
  const built = outcome.built;
  const helper = join(built.runtimeDir, 'tools/unpacked/happier-process-custody');
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(helper, ['disk-measure'], (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.end(JSON.stringify({ paths: [] }));
  });
  assert.deepEqual(JSON.parse(stdout).perPath, []);
  const reused = await native.build({ repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon', env, signal: context.signal });
  assert.equal(reused.entrypoint, built.entrypoint, 'a fresh preparation retains ordinary bundle reuse');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = "requires-build";');
  await writeFile(available, '5242880');
  await withWorkspaceBundleLock(async ({ heldLockValue }) => {
    await assert.rejects(native.build({ repoDir, stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon',
      env: { ...env, HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue }, signal: context.signal }),
      { code: 1, sourceDrift: false }, 're-invocation cannot bypass a live inherited lease or unavailable admission');
  }, { lockPath: fixture.path('unadmitted.lock') });
  assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), []);
  assert.deepEqual(await readdir(join(native.admissionRoot, 'waiters')), []);
  assert.deepEqual(await readdir(join(legacyRoot, 'owners')), []);
  assert.deepEqual(await readdir(join(legacyRoot, 'waiters')), []);
});

test('source daemon owns its UI graph and bytes after checkout artifacts change', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-ui-custody-', registerCleanup:false});
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root, {recursive:true,force:true}); });
  const repoDir = fixture.path('repo');
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const cliDir = join(repoDir,'apps/cli');
  const pluginDir = join(repoDir,'packages/plugins/fixture');
  await mkdir(join(cliDir,'src/plugins/projection/registry/sources'),{recursive:true});
  await mkdir(join(repoDir,'apps/ui'),{recursive:true});
  await mkdir(join(pluginDir,'src'),{recursive:true});
  for (const [source,target] of [['node_modules','node_modules'],['packages/cli-common','packages/cli-common'],['apps/ui/scripts','apps/ui/scripts']]) {
    await symlink(join(canonicalRepo,source),join(repoDir,target),process.platform === 'win32' ? 'junction' : 'dir');
  }
  await writeFile(join(cliDir,'package.json'),JSON.stringify({name:'@happier-dev/cli',type:'module',exports:{}}));
  await writeFile(join(cliDir,'tsconfig.json'),'{}');
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = true;');
  const manifest = {schemaVersion:2,id:'happier.fixture',version:'0.0.0',displayName:'Fixture',runtime:{apiVersion:1},hostAccess:{required:[],optional:[]},
    entrypoints:{daemon:'./dist/index.js'},contributes:{ui:{renderers:[{id:'panel',kind:'reactNative',artifact:'panel'}]}}};
  await writeFile(join(pluginDir,'package.json'),JSON.stringify({name:'@happier-dev/plugins-fixture',version:'0.0.0',type:'module',exports:{
    '.':{'happier-source':'./src/index.ts',default:'./dist/index.js'},
    './happier-plugin-ui/panel':{'happier-source':'./src/panel.ts',default:'./dist/happier-plugin-ui/react-native/panel/entry.cjs.bundle'},
    './happier-plugin-ui/panel/entry.cjs.bundle':{'happier-source':'./src/panel.ts',default:'./dist/happier-plugin-ui/react-native/panel/entry.cjs.bundle'},
  }}));
  await writeFile(join(pluginDir,'src/index.ts'),'export function activate() {}');
  await writeFile(join(pluginDir,'src/panel.ts'),'export function renderSurface() { return "retained-source-panel"; }');
  await writeFile(join(repoDir,'apps/ui/package.json'),JSON.stringify({dependencies:{'@happier-dev/plugins-fixture':'0.0.0'}}));
  await writeFile(join(cliDir,'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'),
    `export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=${JSON.stringify([{daemonEntryPath:'./dist/index.js',sourceSpec:{locator:'@happier-dev/plugins-fixture'},manifest}])};`);
  const runtime = await buildSourceRuntimeBundle({repoDir,outputDir:fixture.path('retained'),component:'daemon'});
  const retainedRoot = join(runtime.runtimeDir,'../../packages/plugins/fixture/dist/happier-plugin-ui');
  const graph = JSON.parse(await readFile(join(retainedRoot,'ui-artifacts.json'),'utf8')).entries[0];
  const retainedBytes = await readFile(join(retainedRoot,graph.entry));
  assert.ok(retainedBytes.includes('retained-source-panel'));
  assert.equal(retainedBytes.length,graph.files[0].byteSize);
  await mkdir(join(pluginDir,'dist/happier-plugin-ui',dirname(graph.entry)),{recursive:true});
  await writeFile(join(pluginDir,'dist/happier-plugin-ui',graph.entry),'changed checkout artifact');
  assert.deepEqual(await readFile(join(retainedRoot,graph.entry)),retainedBytes);
  assert.deepEqual(JSON.parse(await readFile(join(retainedRoot,'ui-artifacts.json'),'utf8')).entries[0],graph);

  // The plugin's daemon module did not change. UI-only changes must still
  // select different emitted code, while the incumbent's bytes remain intact.
  await writeFile(join(pluginDir,'src/panel.ts'),'export function renderSurface() { return "new-source-panel"; }');
  const newer = await buildSourceRuntimeBundle({repoDir,outputDir:fixture.path('newer'),component:'daemon'});
  const newerRoot = join(newer.runtimeDir,'../../packages/plugins/fixture/dist/happier-plugin-ui');
  const newerGraph = JSON.parse(await readFile(join(newerRoot,'ui-artifacts.json'),'utf8')).entries[0];
  assert.notEqual(newer.identity,runtime.identity);
  assert.notEqual(newerGraph.digest,graph.digest);
  assert.ok((await readFile(join(newerRoot,newerGraph.entry))).includes('new-source-panel'));
  assert.deepEqual(await readFile(join(retainedRoot,graph.entry)),retainedBytes);

});

test('source snapshot startup stays pending on a missing source import and rebuilds after its creation', { timeout: 30000 }, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-start-drift-', registerCleanup:false});
  context.after(async () => {
    await makeFixtureWritable(fixture.root);
    await rm(fixture.root, {recursive:true, force:true});
  });
  const repoDir = fixture.path('repo');
  const serverDir = join(repoDir, 'apps/server');
  await mkdir(join(serverDir, 'sources'), {recursive:true});
  await mkdir(join(serverDir, 'scripts'));
  await mkdir(join(serverDir, 'node_modules'));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({name:'@happier-dev/server',type:'module'}));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'sources/main.ts'), 'export {value} from "./createdLater";');
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), 'export const migrate = true;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const abort = new AbortController();
  context.after(() => abort.abort());
  let reportDrift;
  const reported = new Promise(resolve => { reportDrift = resolve; });
  let failures = 0;
  const stackBaseDir = fixture.path('stacks/lane');
  await installSourcePreparationInputs(repoDir, 'server');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const options = {repoDir, stackBaseDir, component:'server', serverComponent:'happier-server', dbProvider:'postgres',
    signal:abort.signal, ...(native ? {env:native.env} : {}), logger:{log() {}, warn() {}, error(message) {
      if (message.includes('will retry when affected inputs change')) { failures++; reportDrift(); }
    }}};
  const pending = (native?.build ?? buildSourceRuntimeBundle)(options);
  const completion = pending.then(built => ({built}), error => ({error}));
  context.after(async () => { abort.abort(); await completion; });
  assert.equal(await Promise.race([reported.then(() => 'waiting'), completion.then(() => 'exited')]), 'waiting',
    'a missing authored import must leave source startup pending');
  await assert.rejects(access(join(stackBaseDir, 'source-runtime/selected-server.json')), {code:'ENOENT'});
  await writeFile(fixture.path('unrelated.ts'), 'export const unrelated = true;');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(failures, 1, 'unrelated edits must not rebuild the source snapshot');
  await writeFile(join(serverDir, 'sources/createdLater.ts'), 'export const value = "recovered";');
  const {built, error} = await completion;
  assert.equal(error, undefined);
  assert.equal((await import(pathToFileURL(built.entrypoint))).value, 'recovered');
  assert.equal(JSON.parse(await readFile(join(stackBaseDir, 'source-runtime/selected-server.json'), 'utf8')).entrypoint,
    built.entrypoint);
  await assert.rejects((native?.build ?? buildSourceRuntimeBundle)({...options, dbProvider:'invalid'}), /Source preparation failed \(exit 1\)/,
    'configuration errors must still fail fast');

  // Simulate only Metro's external process boundary, including its real numeric
  // exit/diagnostic shape. Its wait and input observation use the same owner.
  const uiDir = join(repoDir, 'apps/ui');
  await mkdir(join(uiDir, 'sources'), {recursive:true});
  await mkdir(join(uiDir, 'assets'));
  await mkdir(join(uiDir, 'public'));
  await writeFile(join(uiDir, 'package.json'), JSON.stringify({name:'@happier-dev/ui'}));
  const metro = fixture.path('metro.mjs');
  const hero = join(uiDir, 'sources/HomeHero.tsx');
  await writeFile(metro, `import {existsSync} from 'node:fs';
    if (!existsSync(${JSON.stringify(hero)})) { console.error('Unable to resolve module ./HomeHero from HomeHub.tsx'); process.exit(1); }
    console.log('exported');`);
  let reportMetro;
  const metroWaiting = new Promise(resolve => { reportMetro = resolve; });
  const webOptions = {repoDir, target:'expo', signal:abort.signal,
    logger:{log() {}, warn() {}, error() { reportMetro(); }},
    prepare: () => (native?.runSourceCommand ?? runSourceBuildCommand)({repoDir, scriptPath:metro, signal:abort.signal,
      ...(native ? {env:native.env} : {})})};
  const web = prepareSourceComponent(webOptions);
  const webCompletion = web.then(value => ({value}), error => ({error}));
  context.after(async () => { abort.abort(); await webCompletion; });
  assert.equal(await Promise.race([metroWaiting.then(() => 'waiting'), webCompletion.then(() => 'exited')]), 'waiting');
  await writeFile(hero, 'export const HomeHero = true;');
  assert.deepEqual(await webCompletion, {value:'exported\n'});
  await writeFile(metro, 'console.error("Missing credentials"); process.exit(1);');
  await assert.rejects(prepareSourceComponent(webOptions), /Source preparation failed \(exit 1\)/);
  await writeFile(metro, 'console.error("Unable to resolve module @/components/missing from Sidebar.tsx"); process.exit(1);');
  const cancellation = new AbortController();
  const waitingOnCancel = new Promise(resolve => { reportMetro = resolve; });
  const cancelled = prepareSourceComponent({...webOptions, signal:cancellation.signal});
  const rejection = assert.rejects(cancelled, {name:'AbortError'});
  await waitingOnCancel;
  cancellation.abort();
  await rejection;
});

test('native author input versions accept settled text and refuse changed bytes', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-native-author-input-'});
  const texts = ['export const marker = "ascii";\n', 'export const marker = "雪😀";\n',
    '\uFEFFexport const marker = "BOM";\r\n',
    await readFile(fileURLToPath(new URL('../../../../packages/plugin-sdk/src/index.ts', import.meta.url)), 'utf8')];
  await mkdir(fixture.path('src'));
  for (const [index, text] of texts.entries()) await writeFile(fixture.path(`src/vector${index}.ts`), text);
  const project = fixture.path('tsconfig.json');
  await writeFile(project, JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',
    incremental:true,noResolve:true,noCheck:true,declaration:true,rootDir:'src',outDir:'emitted',
    tsBuildInfoFile:'build.tsbuildinfo'},include:['src/*.ts']}));
  const args = ['-p',project];
  const invocation = resolveTypeScriptCliInvocation({args,admissionClass:'source-bundle'});
  await promisify(execFile)(invocation.command, [...invocation.argsPrefix,...args]);
  const info = JSON.parse(await readFile(fixture.path('build.tsbuildinfo'), 'utf8'));
  for (const [index,text] of texts.entries()) {
    const sourceIndex = info.fileNames.findIndex(path => path.endsWith(`/src/vector${index}.ts`));
    assert.notEqual(sourceIndex, -1);
    const fileInfo = info.fileInfos[sourceIndex];
    const version = typeof fileInfo === 'string' ? fileInfo : fileInfo.version;
    assert.equal(await matchesNativeTypeScriptInputVersion(Buffer.from(text), version), true);
    assert.equal(await matchesNativeTypeScriptInputVersion(Buffer.from(`${text}\n// changed`), version), false,
      'a graph consumed from different bytes must not be reused under restored source');
  }
});

test('source daemon owns a usable public author SDK closure without workspace dist', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-author-sdk-', registerCleanup:false});
  context.after(async () => {
    await makeFixtureWritable(fixture.root);
    await rm(fixture.root, {recursive:true, force:true});
  });
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  const sdkDir = join(repoDir, 'packages/plugin-sdk');
  const protocolDir = join(repoDir, 'packages/protocol');
  for (const directory of [join(cliDir, 'src'), join(cliDir, 'node_modules'), join(sdkDir, 'src'),
    join(protocolDir, 'src'), join(repoDir, 'node_modules/@happier-dev')]) {
    await mkdir(directory, {recursive:true});
  }
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({name:'@happier-dev/cli', type:'module',
    dependencies:{'@happier-dev/plugin-sdk':'0.0.0'},
    bundledDependencies:['@happier-dev/plugin-sdk','@happier-dev/protocol'], exports:{}}));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = true;');
  for (const [name, directory] of [['plugin-sdk', sdkDir], ['protocol', protocolDir]]) {
    await writeFile(join(directory, 'package.json'), JSON.stringify({name:`@happier-dev/${name}`,version:'0.0.0',type:'module',
      main:'./dist/index.js',types:'./dist/index.d.ts',
      exports:{'.':{'happier-source':'./src/index.ts',types:'./dist/index.d.ts',default:'./dist/index.js'}},
      ...(name === 'plugin-sdk' ? {happier:{publicSdkRelease:{posture:'developer_preview'}},
        imports:{'#author-value':{'happier-source':'./src/authorValue.ts',default:'./dist/authorValue.js'}},
        dependencies:{'@happier-dev/protocol':'0.0.0','author-external':'1.0.0'},bundledDependencies:['@happier-dev/protocol']} : {})}));
    await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ES2022',
      module:'NodeNext',moduleResolution:'NodeNext',rootDir:'src',outDir:'dist',declaration:true,
      ...(name === 'plugin-sdk' ? {paths:{'#author-value':['./src/authorValue.ts']}} : {})},include:['src/**/*.ts']}));
    await symlink(directory, join(repoDir, 'node_modules/@happier-dev', name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  await writeFile(join(protocolDir, 'src/index.ts'), 'export const marker = "current-source";');
  await mkdir(join(protocolDir, 'dist'));
  await writeFile(join(protocolDir, 'dist/index.js'), 'export const marker = "stale-dist";');
  await writeFile(join(protocolDir, 'dist/index.d.ts'), 'export declare const marker: "stale-dist";');
  const shadowProtocolDir = join(sdkDir, 'node_modules/@happier-dev/protocol');
  await mkdir(join(shadowProtocolDir, 'src'), {recursive:true});
  await cp(join(protocolDir, 'package.json'), join(shadowProtocolDir, 'package.json'));
  await writeFile(join(shadowProtocolDir, 'src/index.ts'), 'export const marker = "stale-installed-source";');
  // A third-party package may legitimately own dist declarations beneath a
  // workspace's node_modules. These are compiler inputs, not first-party code.
  const externalDir = join(sdkDir, 'node_modules/author-external');
  await mkdir(join(externalDir, 'dist'), {recursive:true});
  await writeFile(join(externalDir, 'package.json'), JSON.stringify({name:'author-external',version:'1.0.0',
    type:'module',types:'./dist/index.d.ts'}));
  await writeFile(join(externalDir, 'dist/index.d.ts'), 'export declare function createAuthorValue(value: string): { value: string };');
  await writeFile(join(externalDir, 'dist/index.js'), 'export function createAuthorValue(value) { return {value}; }');
  await writeFile(join(externalDir, 'package.json'), JSON.stringify({name:'author-external',version:'1.0.0',
    type:'module',main:'./dist/index.js',types:'./dist/index.d.ts'}));
  await writeFile(join(sdkDir, 'src/authorValue.ts'), 'export const authorValue = "package-alias";');
  await writeFile(join(sdkDir, 'src/index.ts'), "/// <reference path='../node_modules/author-external/dist/index.d.ts' />\nimport {marker} from '@happier-dev/protocol';\nexport {marker};\nexport const canonicalMarker = marker;\nimport {authorValue} from '#author-value';\nexport const canonicalAlias = authorValue;\nimport {createAuthorValue} from 'author-external';\nexport function echo(value: string) { return createAuthorValue(value).value; }\n");
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const compilerCommands = fixture.path('author-compiler-commands.jsonl');
  const compilerObserver = fixture.path('observe-author-compiler.mjs');
  // Observe the real OS launch without replacing compiler or domain logic.
  // Native parallel checkers replicate the declaration graph per host CPU.
  await writeFile(compilerObserver, `
    import {createRequire,syncBuiltinESMExports} from 'node:module';
    import {appendFileSync,readFileSync} from 'node:fs';
    const childProcess=createRequire(import.meta.url)('node:child_process');
    const spawn=childProcess.spawn;
    childProcess.spawn=function(command,args,...options) {
      const child=spawn.call(this,command,args,...options);
      if (args?.includes('--noCheck') && args.some(arg=>arg.endsWith('tsconfig.dist.json')))
        child.once('exit',code=>{
          if (code !== 0) return;
          const info=JSON.parse(readFileSync(args[args.indexOf('--tsBuildInfoFile')+1],'utf8'));
          appendFileSync(${JSON.stringify(compilerCommands)},JSON.stringify({args,files:info.fileNames})+'\\n');
        });
      return child;
    };
    syncBuiltinESMExports();
  `);
  const env = {...process.env,
    NODE_OPTIONS:`${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(compilerObserver).href}`.trim()};
  const stackBaseDir = fixture.path('stacks/author');
  await installSourcePreparationInputs(repoDir, 'daemon');
  const runtime = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon', env});
  const authorCommands = (await readFile(compilerCommands, 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(authorCommands.length > 0, 'the real public author compiler was observed');
  for (const {args} of authorCommands) assert.ok(args.includes('--singleThreaded'),
    'author declaration emission must not replicate its checker graph with host CPU count');
  const sdkCompiler = authorCommands.find(({args})=>args.some(arg=>arg.replaceAll('\\','/').includes('/plugin-sdk/tsconfig.dist.json')));
  assert.ok(sdkCompiler, 'the SDK declaration compiler was observed');
  assert.equal(sdkCompiler.files.some(path=>path.replaceAll('\\','/').endsWith('/protocol/src/index.ts')), false,
    'dependent author packages must consume the already emitted current-source declaration, not re-emit its source');
  const record = JSON.parse(await readFile(join(runtime.runtimeDir, '../../source-bundle.json'), 'utf8'));
  const sdkInput = Object.entries(record.sourceInputDigests).find(([path]) => path.endsWith('packages/plugin-sdk/src/index.ts'));
  assert.match(sdkInput?.[1], /^[a-f0-9]{64}$/,
    'settled compiler source bytes must remain eligible for normal source-bundle reuse');
  assert.equal(Object.keys(record.sourceInputDigests).some(path => path.includes('node_modules/@happier-dev/protocol/')), false,
    'author declarations must resolve canonical workspace source rather than a stale installed shadow');
  const warm = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'daemon'});
  assert.equal(warm.entrypoint, runtime.entrypoint, 'settled public author closure reuses the existing source bundle');
  // The running source CLI must serve the real public resolver without looking
  // for a repository around the emitted runtime or reopening its moving input.
  const canonicalRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const resolverUrl = pathToFileURL(join(canonicalRepo, 'apps/cli/src/plugins/authoring/hostSdkResolution.ts')).href;
  const {stdout} = await promisify(execFile)(process.execPath, ['--import',
    pathToFileURL(join(canonicalRepo, 'packages/cli-common/registerSourceRuntime.mjs')).href,
    '--input-type=module', '--eval', `import {resolveHostPluginSdkPackageRoot} from ${JSON.stringify(resolverUrl)};
      console.log(resolveHostPluginSdkPackageRoot({runtimeModuleUrl:${JSON.stringify(pathToFileURL(runtime.entrypoint).href)}}));`],
    {cwd:join(canonicalRepo, 'apps/cli'), env:{...process.env,...runtime.env}});
  const sdkRoot = stdout.trim();
  assert.equal(relative(await realpath(runtime.runtimeDir), sdkRoot).startsWith('..'), false);
  const declarations = await readFile(join(sdkRoot, 'dist/index.d.ts'), 'utf8');
  assert.match(declarations, /echo\(value: string\): string/);
  assert.match(declarations, /canonicalMarker = "current-source"/);
  assert.match(declarations, /canonicalAlias = "package-alias"/);
  const nestedRuntime = await buildSourceRuntimeBundle({repoDir, outputDir:join(cliDir, '.source-output'), component:'daemon'});
  assert.match(await readFile(join(nestedRuntime.runtimeDir, 'authoring/node_modules/@happier-dev/plugin-sdk/dist/index.d.ts'), 'utf8'),
    /canonicalMarker = "current-source"/, 'private current-build declarations remain valid even when output is inside the checkout');
  await writeFile(join(protocolDir, 'src/index.ts'), 'export const marker = "moving-source";');
  const author = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href);
  assert.equal(author.marker, 'current-source');
  assert.equal(author.echo('author-value'), 'author-value');
  assert.equal(author.canonicalAlias, 'package-alias');
  await assert.rejects(access(join(sdkDir, 'dist')), {code:'ENOENT'});
  assert.match(await readFile(join(protocolDir, 'dist/index.js'), 'utf8'), /stale-dist/);
  await writeFile(join(sdkDir, 'src/index.ts'), "export {marker} from '../../protocol/dist/index.js';");
  await assert.rejects(buildSourceRuntimeBundle({repoDir,stackBaseDir,component:'daemon'}),
    /Source preparation failed \(exit 1\)/);
});

for (const consumed of [false, true]) {
  test(`moving source preparation succeeds when an ${consumed ? 'actually consumed' : 'unconsumed'} input changes without caching it under stale source`, async context => {
    const fixture = await createTempFixture(context, {prefix:'happier-moving-source-', registerCleanup:false});
    context.after(async () => {
      await makeFixtureWritable(fixture.root);
      await rm(fixture.root, {recursive:true, force:true});
    });
    const repoDir = fixture.path('repo');
    const cliDir = join(repoDir, 'apps/cli');
    const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
    await mkdir(locatorDir, {recursive:true});
    await mkdir(join(cliDir, 'node_modules'));
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({name:'@happier-dev/cli', type:'module', exports:{}}));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
    const original = 'export const ready = 1;';
    const entry = join(cliDir, 'src/index.ts');
    const changedFile = consumed ? entry : join(cliDir, 'src/unconsumed.ts');
    await writeFile(entry, original);
    await writeFile(changedFile, original);
    const builds = fixture.path('builds');
    // The real entry-discovery transform runs after cache admission and before
    // esbuild reads the graph. Its fixture edits exactly once, with no timers.
    await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'), `
      import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
      if (!existsSync(${JSON.stringify(builds)})) writeFileSync(${JSON.stringify(changedFile)},'export const ready = 2;');
      appendFileSync(${JSON.stringify(builds)},'built\\n');
      export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];
    `);
    const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
    await installSourcePreparationInputs(repoDir, 'daemon');
    const build = native?.build ?? buildSourceRuntimeBundle;
    const env = {...(native?.env ?? process.env)};
    if (consumed) {
      const observer = fixture.path('observe-read.mjs');
      // Observe real filesystem IO: return the bytes actually read, then model
      // an editor undo before preparation finishes. No bundler/domain mock.
      await writeFile(observer, `
        import {createRequire,syncBuiltinESMExports} from 'node:module';
        const fs=createRequire(import.meta.url)('node:fs/promises');
        const read=fs.readFile;
        const physicalEntry=await fs.realpath(${JSON.stringify(entry)});
        fs.readFile=async (...args)=>{
          const contents=await read(...args);
          if ((String(args[0])===${JSON.stringify(entry)} || String(args[0])===physicalEntry) && String(contents)==='export const ready = 2;')
            await fs.writeFile(${JSON.stringify(entry)},${JSON.stringify(original)});
          return contents;
        };
        syncBuiltinESMExports();
      `);
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(observer).href}`.trim();
    }
    const stackBaseDir = fixture.path('stacks/consumer');
    const first = await build({repoDir, stackBaseDir, component:'daemon', env});
    assert.equal((await import(pathToFileURL(first.entrypoint))).ready, consumed ? 2 : 1);
    if (consumed) assert.equal(await readFile(entry, 'utf8'), original,
      'the editor undo occurred after the consumed bytes were read, before completion');
    const graph = JSON.parse(await readFile(join(first.runtimeDir, 'metafile.json'), 'utf8'));
    assert.equal(Object.keys(graph.inputs).includes('apps/cli/src/unconsumed.ts'), false);
    // Restoring the initial source must not adopt a result that consumed the
    // intervening bytes. Simply removing the old rejection fails this check.
    await writeFile(changedFile, original);
    const second = await build({repoDir, stackBaseDir, component:'daemon', env});
    assert.equal((await import(pathToFileURL(second.entrypoint))).ready, 1);
    if (consumed) assert.notEqual(first.identity, second.identity);
    else assert.equal(first.identity, second.identity, 'unconsumed edits cannot change emitted code identity');
    const stable = await build({repoDir, stackBaseDir, component:'daemon', env});
    assert.equal(stable.entrypoint, second.entrypoint, 'settled inputs retain warm reuse');
    assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 2);
  });
}

test('concurrent stacks share one read-only source bundle and retain selected bundles across source changes', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-source-dedupe-'));
  let live;
  context.after(async () => {
    if (live && live.exitCode === null) {
      const retired = new Promise(resolve => live.once('exit', resolve));
      live.kill();
      await retired;
    }
    await makeFixtureWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const repoDir = join(root, 'repo');
  const cliDir = join(repoDir, 'apps/cli');
  const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
  await mkdir(locatorDir, { recursive: true });
  await mkdir(join(cliDir, 'node_modules'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 1;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const builds = join(root, 'builds');
  await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'), `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(builds)}, 'built\\n'); export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];`);
  const stacks = [join(root, 'stacks/a'), join(root, 'stacks/b')];
  await installSourcePreparationInputs(repoDir, 'daemon');
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(root) : null;
  const build = native?.build ?? buildSourceRuntimeBundle;
  const buildEnv = {...process.env};
  for (const key of Object.keys(buildEnv)) if (key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_') || key.startsWith('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_')) delete buildEnv[key];
  if(native) {
    buildEnv.PATH = native.env.PATH;
    buildEnv.HAPPIER_DEV_TARGET_EXECUTION = native.env.HAPPIER_DEV_TARGET_EXECUTION;
  }
  const runtimeUrl = native ? pathToFileURL(native.runtimePath).href : new URL('./build_source_runtime.mjs',import.meta.url).href;
  const script = `import {buildSourceRuntimeBundle} from ${JSON.stringify(runtimeUrl)}; console.log(JSON.stringify(await buildSourceRuntimeBundle({repoDir:process.argv[1],stackBaseDir:process.argv[2],component:'daemon'})));`;
  const results = await Promise.all(stacks.map(async stackBaseDir => {
    const {stdout} = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, repoDir, stackBaseDir], {env:buildEnv});
    return JSON.parse(stdout);
  }));
  assert.equal(results[0].entrypoint, results[1].entrypoint);
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  if (process.platform !== 'win32') assert.equal((await stat(results[0].entrypoint)).mode & 0o222, 0);
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 1;');
  const unchanged = await build({repoDir, stackBaseDir:stacks[0], component:'daemon',env:buildEnv});
  assert.equal(unchanged.entrypoint, results[0].entrypoint, 'content, not write time, owns reuse');
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 2;');
  const recovered = await build({repoDir, stackBaseDir: stacks[0], component:'daemon', reuseSelected:true,env:buildEnv});
  assert.equal(recovered.entrypoint, results[0].entrypoint, 'in-run recovery keeps the selected emitted graph despite moving source');
  assert.equal(recovered.identity, results[0].identity);
  assert.equal((await readFile(builds, 'utf8')).trim().split('\n').length, 1);
  const second = await build({repoDir, stackBaseDir: stacks[0], component:'daemon',env:buildEnv});
  assert.notEqual(second.entrypoint, results[0].entrypoint);
  await access(results[0].entrypoint); // Other stack still selects this bundle.
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 3; console.log("ready"); setInterval(()=>{},1000);');
  const third = await build({repoDir, stackBaseDir: stacks[0], component:'daemon',env:buildEnv});
  if (process.platform === 'win32') await access(second.entrypoint); // No authoritative process observation: retain.
  else await assert.rejects(access(second.entrypoint), {code:'ENOENT'});
  await access(results[0].entrypoint);
  await access(third.entrypoint);
  await assert.rejects(build({repoDir, stackBaseDir: join(root, 'stacks/unselected'), component:'daemon', reuseSelected:true,env:buildEnv}),
    /selected source daemon bundle.*unavailable/i, 'recovery cannot silently build current source when selection is missing');
  assert.equal((await readdir(join(root, 'stacks/source-bundles'))).filter(name => name.startsWith('bundle-')).length, process.platform === 'win32' ? 3 : 2);
  live = spawn(process.execPath, [third.entrypoint], {env:{...process.env,...third.env},stdio:['ignore','pipe','inherit']});
  await new Promise((resolve,reject) => { live.once('error',reject);live.stdout.once('data',resolve);live.once('exit',code=>reject(new Error(`source runtime exited before readiness (${code})`))); });
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 4;');
  const fourth = await build({repoDir, stackBaseDir:stacks[0], component:'daemon',env:buildEnv});
  await access(third.entrypoint); // Live runtime retains its old launch independently of selection.
  await writeFile(join(cliDir, 'src/index.ts'), 'export const ready = 1;');
  const readopted = await build({repoDir, stackBaseDir:stacks[0], component:'daemon',env:buildEnv});
  assert.equal(readopted.entrypoint, results[0].entrypoint);
  await access(fourth.entrypoint); // The newest built bundle survives adopting an older selected bundle.
});

test('source CLI commands preserve a pending start selection across source changes and peer reclamation',
  { skip: process.platform !== 'linux' }, async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-cli-selection-', registerCleanup: false });
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root, { recursive: true, force: true }); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir, 'apps/cli');
  await mkdir(join(cliDir, 'src'), { recursive: true });
  await mkdir(join(cliDir, 'node_modules'));
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
  await writeFile(join(cliDir, 'tsconfig.json'), '{}');
  const entry = join(cliDir, 'src/index.ts');
  await writeFile(entry, 'export const ready = 1;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), 'dir');
  await installSourcePreparationInputs(repoDir, 'daemon');
  const stackBaseDir = fixture.path('stacks/consumer');
  const options = { repoDir, stackBaseDir, component: 'daemon', env: native.env, signal: context.signal };
  const pending = await native.build(options);
  const selectionPath = join(stackBaseDir, 'source-runtime/selected-daemon.json');
  const selection = await readFile(selectionPath, 'utf8');

  // Install the real launch-context owner beside the fixture launcher. Only
  // import locations change; CLI resolution, selection and reclamation stay real.
  const contextSource = new URL('../runtime/launch/resolveStackRuntimeLaunchContext.mjs', import.meta.url);
  const contextPath = fixture.path('native-owner/apps/stack/scripts/runtime/launch/resolveStackRuntimeLaunchContext.mjs');
  await mkdir(dirname(contextPath), { recursive: true });
  await writeFile(contextPath, (await readFile(contextSource, 'utf8'))
    .replace(/(from )'(\.[^']+)'/g, (_match, prefix, path) => `${prefix}${JSON.stringify(new URL(path, contextSource).href)}`));
  const { resolveStackRuntimeLaunchContext } = await import(pathToFileURL(contextPath));
  const env = { ...native.env, HAPPIER_STACK_REPO_DIR: repoDir,
    HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'), HAPPIER_STACK_STACK: 'consumer' };
  await writeFile(entry, 'export const ready = 2;');
  // The start has selected its graph but has not published runtime state or
  // launched a process yet (for example, it is still exporting the web UI).
  const command = await resolveStackRuntimeLaunchContext({ argv: ['--runtime=source'], env });
  assert.equal(command.cliLaunchSpec.entrypoint, pending.entrypoint);
  assert.equal(await readFile(selectionPath, 'utf8'), selection);
  const peer = await native.build({ ...options, stackBaseDir: fixture.path('stacks/peer') });
  await access(pending.entrypoint);
  assert.equal((await import(pathToFileURL(command.cliLaunchSpec.entrypoint))).ready, 1);

  // A CLI-only stack can still bootstrap when it has never selected a graph.
  const bootstrap = await resolveStackRuntimeLaunchContext({ argv: ['--runtime=source'],
    env: { ...env, HAPPIER_STACK_STACK: 'bootstrap' } });
  assert.equal(bootstrap.cliLaunchSpec.entrypoint, peer.entrypoint);
  const unavailableSelection = JSON.stringify({ entrypoint: fixture.path('missing/apps/cli/src/index.mjs') });
  const bootstrapSelection = fixture.path('stacks/bootstrap/source-runtime/selected-daemon.json');
  await writeFile(bootstrapSelection, unavailableSelection);
  await assert.rejects(resolveStackRuntimeLaunchContext({ argv: ['--runtime=source'],
    env: { ...env, HAPPIER_STACK_STACK: 'bootstrap' }, activeRuntimeState: { sourceRuntimeLaunch: null } }),
    /selected source daemon bundle.*unavailable/i);
  assert.equal(await readFile(bootstrapSelection, 'utf8'), unavailableSelection,
    'an unavailable selected graph must fail closed instead of replacing its pin');
  // Once the real startup replaces the selection, the old unlaunched graph
  // becomes reclaimable; command resolution must not create a permanent pin.
  await native.build(options);
  await assert.rejects(access(pending.entrypoint), { code: 'ENOENT' });
});

test('a cold source CLI bootstrap adopts a selection published during its build',
  { skip: process.platform !== 'linux' }, async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-cli-cold-selection-', registerCleanup: false });
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root, { recursive: true, force: true }); });
  const native = await installSourceAdmissionFixture(fixture.root);
  // Admit the two tiny real graphs independently, as in the existing
  // unfinished-producer test; the OS resource observation is the only seam.
  await writeFile(fixture.path('bin/awk'), `#!/bin/sh\ncase "$*" in\n */proc/meminfo*) printf '67108864 67108864\\n' ;;\n */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;\n *) exec /usr/bin/awk "$@" ;;\nesac\n`);
  const started = fixture.path('started');
  const release = fixture.path('release');
  const watcher = watch(fixture.root);
  context.after(() => watcher.close());
  const active = new Promise((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('change', (_event, name) => { if (name === 'started') resolve(); });
  });
  const repos = [fixture.path('command-repo'), fixture.path('start-repo')];
  for (const [index, repoDir] of repos.entries()) {
    const cliDir = join(repoDir, 'apps/cli');
    const locator = join(cliDir, 'src/plugins/projection/registry/sources');
    await mkdir(locator, { recursive: true });
    await mkdir(join(cliDir, 'node_modules'));
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await writeFile(join(cliDir, 'src/index.ts'), `export const ready = ${index};`);
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'), 'dir');
    await writeFile(join(locator, 'generatedBundledPluginManifests.ts'), (index === 0
      ? `import {writeFileSync,existsSync} from 'node:fs'; writeFileSync(${JSON.stringify(started)},'ready'); while(!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10)); ` : '')
      + 'export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];');
    await installSourcePreparationInputs(repoDir, 'daemon');
  }
  const controller = new AbortController();
  const options = { stackBaseDir: fixture.path('stacks/consumer'), component: 'daemon', env: native.env,
    signal: AbortSignal.any([controller.signal, context.signal]) };
  const command = native.build({ ...options, repoDir: repos[0], reuseSelected: 'if-available' });
  const completion = command.then(built => ({ built }), error => ({ error }));
  context.after(async () => { controller.abort(); await completion; });
  await active;
  const pending = await native.build({ ...options, repoDir: repos[1] });
  await writeFile(release, 'release');
  const outcome = await completion;
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.built.entrypoint, pending.entrypoint);
  assert.equal(JSON.parse(await readFile(join(options.stackBaseDir, 'source-runtime/selected-daemon.json'), 'utf8')).entrypoint,
    pending.entrypoint);
  assert.equal((await import(pathToFileURL(pending.entrypoint))).ready, 1);
});

test('failed source completion publication preserves the previous coherent selection',
  {skip:process.platform !== 'linux',timeout:30000}, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-publication-failure-',registerCleanup:false});
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root,{recursive:true,force:true}); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir,'apps/cli');
  await mkdir(join(cliDir,'src'),{recursive:true});
  await mkdir(join(cliDir,'node_modules'));
  await writeFile(join(cliDir,'package.json'),JSON.stringify({name:'@happier-dev/cli',type:'module',exports:{}}));
  await writeFile(join(cliDir,'tsconfig.json'),'{}');
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = 1;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),join(cliDir,'node_modules/esbuild'),'dir');
  await installSourcePreparationInputs(repoDir,'daemon');
  const options = {repoDir,stackBaseDir:fixture.path('stacks/consumer'),component:'daemon',env:native.env,signal:context.signal};
  const prior = await native.build(options);
  const selectionPath = join(options.stackBaseDir,'source-runtime/selected-daemon.json');
  const priorSelection = await readFile(selectionPath,'utf8');
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = 2;');
  const preload = fixture.path('filesystem-fault.mjs');
  // Only the real filesystem completion-rename boundary fails; all graph,
  // admission, selection and retention logic stays real.
  await writeFile(preload, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    import {basename} from 'node:path'; const rename=fs.rename;
    fs.rename=async(from,to)=>{if(basename(to)==='source-bundle.json')throw Object.assign(new Error('ENOSPC at source-bundle completion publication'),{code:'ENOSPC'});return rename(from,to)};
    syncBuiltinESMExports();`);
  await assert.rejects(native.build({...options,env:{...native.env,
    NODE_OPTIONS:[native.env.NODE_OPTIONS,`--import=${pathToFileURL(preload).href}`].filter(Boolean).join(' ')}}),
    /Source preparation failed \(exit 1\)/);
  assert.equal(await readFile(selectionPath,'utf8'),priorSelection,
    'failed completion publication must preserve the previous coherent selection');
  const recovered = await native.build({...options,reuseSelected:true});
  assert.equal(recovered.entrypoint,prior.entrypoint);
  assert.equal((await import(pathToFileURL(recovered.entrypoint))).ready,1);
  assert.equal((await readdir(fixture.path('stacks/source-bundles'))).filter(name=>name.startsWith('bundle-')).length,1);
});

test('different source fingerprints compile independently and retention preserves an unfinished graph',
  {skip:process.platform !== 'linux',timeout:30000}, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-independent-',registerCleanup:false});
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root,{recursive:true,force:true}); });
  const native = await installSourceAdmissionFixture(fixture.root);
  // Two tiny real esbuild graphs fit; report enough host memory to admit both.
  await writeFile(fixture.path('bin/awk'), `#!/bin/sh\ncase "$*" in\n */proc/meminfo*) printf '67108864 67108864\\n' ;;\n */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;\n *) exec /usr/bin/awk "$@" ;;\nesac\n`);
  const started = fixture.path('started');
  const release = fixture.path('release');
  const watcher = watch(fixture.root);
  context.after(() => watcher.close());
  const active = new Promise((resolve,reject) => {
    watcher.on('error',reject);
    watcher.on('change',(_event,name) => { if(name==='started') resolve(); });
  });
  const repos = [fixture.path('repo-a'),fixture.path('repo-b')];
  for (const [index,repoDir] of repos.entries()) {
    const cliDir = join(repoDir,'apps/cli');
    const locator = join(cliDir,'src/plugins/projection/registry/sources');
    await mkdir(locator,{recursive:true});
    await mkdir(join(cliDir,'node_modules'));
    await writeFile(join(cliDir,'package.json'),JSON.stringify({name:'@happier-dev/cli',type:'module',exports:{}}));
    await writeFile(join(cliDir,'tsconfig.json'),'{}');
    await writeFile(join(cliDir,'src/index.ts'),`export const ready = ${index};`);
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),join(cliDir,'node_modules/esbuild'),'dir');
    await writeFile(join(locator,'generatedBundledPluginManifests.ts'), (index===0
      ? `import {writeFileSync,existsSync} from 'node:fs'; writeFileSync(${JSON.stringify(started)},'ready'); while(!existsSync(${JSON.stringify(release)})) await new Promise(resolve=>setTimeout(resolve,10)); ` : '')
      + 'export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];');
    await installSourcePreparationInputs(repoDir,'daemon');
  }
  const controller = new AbortController();
  const first = native.build({repoDir:repos[0],stackBaseDir:fixture.path('stacks/a'),component:'daemon',
    env:native.env,signal:AbortSignal.any([controller.signal,context.signal])});
  const completion = first.then(built=>({built}),error=>({error}));
  context.after(async () => { controller.abort(); await completion; });
  await active;
  const second = await native.build({repoDir:repos[1],stackBaseDir:fixture.path('stacks/b'),component:'daemon',
    env:native.env,signal:context.signal});
  assert.equal((await import(pathToFileURL(second.entrypoint))).ready,1);
  await writeFile(release,'release');
  const outcome = await completion;
  if(outcome.error) throw outcome.error;
  assert.equal((await import(pathToFileURL(outcome.built.entrypoint))).ready,0);
  await access(second.entrypoint);
});

test('shared source preparation releases its build lock while queued and selected recovery does not need build admission',
  {skip:process.platform !== 'linux',timeout:30000}, async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-joint-admission-',registerCleanup:false});
  context.after(async () => { await makeFixtureWritable(fixture.root); await rm(fixture.root,{recursive:true,force:true}); });
  const native = await installSourceAdmissionFixture(fixture.root);
  const {build} = native;
  const available = fixture.path('available-memory');
  const observed = fixture.path('memory-observed');
  await writeFile(available,'16777216');
  await writeFile(fixture.path('bin/awk'),`#!/bin/sh
case "$*" in
  */proc/meminfo*)
    available=$(/bin/cat '${available}')
    printf '%s 16777216\\n' "$available"
    [ "$available" -ne 5242880 ] || printf observed > '${observed}'
    ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
  await chmod(fixture.path('bin/awk'),0o755);
  const env = {...process.env,PATH:`${fixture.path('bin')}:/usr/bin:/bin`,HAPPIER_DEV_TARGET_EXECUTION:'1'};
  for(const key of Object.keys(env)) if(key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_') || key.startsWith('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_')) delete env[key];
  const repoDir = fixture.path('repo');
  const cliDir = join(repoDir,'apps/cli');
  await mkdir(join(cliDir,'src'),{recursive:true});
  await mkdir(join(cliDir,'node_modules'));
  await writeFile(join(cliDir,'package.json'),JSON.stringify({name:'@happier-dev/cli',type:'module',exports:{}}));
  await writeFile(join(cliDir,'tsconfig.json'),'{}');
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = 1;');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),join(cliDir,'node_modules/esbuild'),'dir');
  const stackBaseDir = fixture.path('stacks/consumer');
  await installSourcePreparationInputs(repoDir, 'daemon');
  const options = {repoDir,stackBaseDir,component:'daemon',env};
  const selected = await build(options);
  // A queued launcher may have parsed the preceding worker payload before
  // source changes. Exercise that actual process boundary, not a mock caller.
  const priorPayload = JSON.parse(await native.runSourceCommand({repoDir,scriptPath:native.runtimePath,
    args:[JSON.stringify({repoDir,stackBaseDir,component:'daemon',serverComponent:'happier-server-light'})],env,signal:context.signal,
    admissionClass:'source-bundle'}));
  assert.equal(priorPayload.entrypoint,selected.entrypoint,'a queued preceding launcher still receives its runtime');
  await writeFile(available,'5242880');
  const warm = await build({...options,signal:context.signal});
  assert.equal(warm.entrypoint,selected.entrypoint,'unchanged inputs reuse a bundle without compiler memory admission');
  await writeFile(available,'16777216');
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = 2;');
  const buildLockPath = fixture.path('stacks/source-bundles/build.lock');
  let lockDiagnostic = '';
  const stderrWrite = process.stderr.write;
  process.stderr.write = function(chunk,...args) {
    lockDiagnostic += String(chunk);
    return stderrWrite.call(this,chunk,...args);
  };
  context.after(()=> { process.stderr.write=stderrWrite; });
  await withWorkspaceBundleLock(async () => {
    const independent = await build({...options,signal:context.signal});
    assert.equal((await import(pathToFileURL(independent.entrypoint))).ready,2,
      'an unrelated legacy global build lock cannot serialize current fingerprints');
  }, {lockPath:buildLockPath,signal:context.signal});
  const afterLockWait = await build({...options,signal:context.signal});
  assert.notEqual(afterLockWait.entrypoint,selected.entrypoint);
  assert.equal((await import(pathToFileURL(afterLockWait.entrypoint))).ready,2);
  await writeFile(join(cliDir,'src/index.ts'),'export const ready = 3;');
  await writeFile(available,'5242880');
  const watcher = watch(fixture.root);
  context.after(()=>watcher.close());
  const pressure = new Promise((resolve,reject)=> {
    watcher.on('error',reject);
    watcher.on('change',(_event,name)=> { if(name==='memory-observed') { watcher.close(); resolve(); } });
  });
  const controller = new AbortController();
  let waiting;
  const queued = new Promise(resolve=> { waiting=resolve; });
  const admissionDiagnosticWrite = process.stderr.write;
  process.stderr.write = function(chunk,...args) {
    lockDiagnostic += String(chunk);
    if(lockDiagnostic.includes('[preferred-execution] waiting for heavyweight admission')) waiting();
    return admissionDiagnosticWrite.call(this,chunk,...args);
  };
  const pending = build({...options,signal:AbortSignal.any([controller.signal,context.signal])});
  const completion = pending.then(built=>({built}),error=>({error}));
  context.after(async()=> { controller.abort(); await completion; });
  await Promise.all([pressure,queued]);
  await assert.rejects(access(fixture.path('stacks/source-bundles/build.lock')),{code:'ENOENT'},
    'waiting for source-build capacity cannot retain the shared publication lock');
  const recovered = await build({...options,reuseSelected:true,signal:context.signal});
  assert.equal(recovered.entrypoint,afterLockWait.entrypoint,'selected runtime recovery bypasses heavyweight admission');
  await writeFile(available,'16777216');
  const next = await completion;
  if(next.error) throw next.error;
  assert.notEqual(next.built.entrypoint,afterLockWait.entrypoint);
  assert.equal((await import(pathToFileURL(next.built.entrypoint))).ready,3);
  assert.deepEqual(await readdir(join(native.admissionRoot,'owners')),[]);
  assert.deepEqual(await readdir(join(native.admissionRoot,'waiters')),[]);
});

test('one-shot source builds retire their real preparation process after success and failure', async (context) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-service-'));
  context.after(() => rm(repoDir, { recursive: true, force: true }));
  await linkCanonicalServerWorkspace(repoDir);
  const serverDir = join(repoDir, 'apps/server');
  await mkdir(join(serverDir, 'sources'), { recursive: true });
  await mkdir(join(serverDir, 'node_modules'), { recursive: true });
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), JSON.stringify({
    extends:fileURLToPath(new URL('../../../server/tsconfig.json', import.meta.url)),
  }));
  await writeFile(join(serverDir, 'sources/main.light.ts'), 'export const ready = true;');
  await mkdir(join(serverDir, 'scripts'));
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'),
    `export {runSqliteMigrationDeploy} from ${JSON.stringify(fileURLToPath(new URL('../../../server/scripts/migrate.sqlite.deploy.ts', import.meta.url)))};`);
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  // Observe the real OS process boundary in an isolated host so no other build
  // can own the installed esbuild service. All spawn calls still execute.
  const script = `
    import {createRequire} from 'node:module';
    import {writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    const require=createRequire(import.meta.url), cp=require('node:child_process');
    const spawn=cp.spawn, services=[];
    cp.spawn=function(command,args,options){
      const child=spawn.call(this,command,args,options);
      if(args?.some(arg=>arg.startsWith('--service=') || arg.endsWith('build_source_runtime.mjs'))) services.push(child);
      return child;
    };
    const {buildSourceRuntimeBundle}=await import(${JSON.stringify(new URL('./build_source_runtime.mjs', import.meta.url).href)});
    const repoDir=process.argv[1], results=[];
    try {
      for(const failure of [false,true]) {
        if(failure) await writeFile(join(repoDir,'apps/server/sources/main.light.ts'),'import "./missing-source";');
        let rejected=false;
        try {await buildSourceRuntimeBundle({repoDir,outputDir:join(repoDir,failure?'failure':'success'),component:'server'});}
        catch(error){if(!failure) throw error; rejected=true;}
        const child=services.at(-1);
        if(!child) throw new Error('real source preparation process was not observed');
        const retired=await new Promise(resolve=>{
          if(child.exitCode!==null || child.signalCode!==null) return resolve(true);
          const timer=setTimeout(()=>resolve(false),1000);
          child.once('exit',()=>{clearTimeout(timer);resolve(true);});
        });
        results.push({failure,rejected,retired});
      }
      console.log(JSON.stringify(results));
    } finally {require(join(repoDir,'apps/server/node_modules/esbuild')).stop();}
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script, repoDir]);
  assert.deepEqual(JSON.parse(stdout.trim()), [
    { failure: false, rejected: false, retired: true },
    { failure: true, rejected: true, retired: true },
  ]);
});

test('source bundle freezes source exports and a lazy entry without consuming dist', async (context) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-runtime-'));
  context.after(() => rm(repoDir, { recursive: true, force: true }));
  const cliDir = join(repoDir, 'apps/cli');
  const packageDir = join(repoDir, 'packages/example');
  const unscopedDir = join(repoDir, 'packages/unscoped');
  const sdkDir = join(repoDir, 'packages/sdk');
  const protocolDir = join(repoDir, 'packages/protocol');
  await Promise.all([mkdir(join(cliDir, 'src'), { recursive: true }), mkdir(join(packageDir, 'src'), { recursive: true }), mkdir(join(repoDir, 'node_modules/@happier-dev'), { recursive: true })]);
  await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', dependencies: {}, exports: { './lib': { 'happier-source': './src/library.ts', default: './dist/lib.mjs' } } }));
  await writeFile(join(cliDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }));
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@happier-dev/example', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(packageDir, 'src/index.ts'), "export const value = 'frozen';\n");
  await mkdir(join(unscopedDir, 'src'), { recursive: true });
  await mkdir(join(unscopedDir, 'dist'), { recursive: true });
  await writeFile(join(unscopedDir, 'package.json'), JSON.stringify({ name: 'unscoped-first-party', type: 'module', exports: { import: { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(unscopedDir, 'src/index.ts'), "export const value = '-unscoped';\n");
  await writeFile(join(unscopedDir, 'dist/index.js'), "export const value = '-stale-dist';\n");
  await symlink(unscopedDir, join(repoDir, 'node_modules/unscoped-first-party'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(sdkDir, 'src'), { recursive: true });
  await mkdir(join(protocolDir, 'src'), { recursive: true });
  await writeFile(join(sdkDir, 'package.json'), JSON.stringify({ name: '@happier-dev/sdk', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } }, imports: { '#http': { 'happier-source': './src/http.ts', default: './dist/http.js' } } }));
  await writeFile(join(sdkDir, 'src/index.ts'), "export { value } from '#http';\n");
  await writeFile(join(sdkDir, 'src/http.ts'), "export { value } from '@happier-dev/protocol';\n");
  await writeFile(join(protocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(protocolDir, 'src/index.ts'), "export { value } from './authored';\n");
  await writeFile(join(protocolDir, 'src/authored.ts'), "export const value = '-canonical-protocol';\n");
  // A public bundled SDK dependency can retain a source condition while lacking
  // the authored transitive source. Native source builds must use the workspace
  // authority, not this nearer installed copy or its stale emitted fallback.
  const shadowProtocolDir = join(sdkDir, 'node_modules/@happier-dev/protocol');
  await mkdir(join(shadowProtocolDir, 'src'), { recursive: true });
  await writeFile(join(shadowProtocolDir, 'package.json'), JSON.stringify({ name: '@happier-dev/protocol', type: 'module', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  await writeFile(join(shadowProtocolDir, 'src/index.ts'), "export { value } from './missing-bundled-source';\n");
  await symlink(sdkDir, join(repoDir, 'node_modules/@happier-dev/sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(protocolDir, join(repoDir, 'node_modules/@happier-dev/protocol'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(cliDir, 'src/index.ts'), "import {value} from '@happier-dev/example'; import {value as unscoped} from 'unscoped-first-party'; import {value as sdk} from '@happier-dev/sdk'; export const read = async () => value + (await import('./lazy')).value + unscoped + sdk;\n");
  await writeFile(join(cliDir, 'src/lazy.ts'), "export const value = '-lazy';\n");
  await writeFile(join(cliDir, 'src/library.ts'), "export const value = 'frozen-library';\n");
  await mkdir(join(cliDir, 'scripts'), { recursive: true });
  await writeFile(join(cliDir, 'scripts/process_tree.cjs'), "exports.read = async () => (await import('@happier-dev/example')).value;\n");
  await symlink(packageDir, join(repoDir, 'node_modules/@happier-dev/example'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(repoDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), join(repoDir, 'node_modules/tsx'), process.platform === 'win32' ? 'junction' : 'dir');
  const sourceToolsDir = join(repoDir, 'packages/cli-common');
  await mkdir(sourceToolsDir, { recursive: true });
  for (const file of ['registerSourceRuntime.mjs', 'sourceRuntimeEntries.mjs', 'cliRuntimeSidecars.mjs']) {
    await cp(new URL('../../../../packages/cli-common/' + file, import.meta.url), join(sourceToolsDir, file));
  }
  const { stdout: sdkSourceValue } = await promisify(execFile)(process.execPath, [
    '--import', pathToFileURL(join(sourceToolsDir, 'registerSourceRuntime.mjs')).href,
    '--input-type=module', '--eval', "console.log((await import('@happier-dev/sdk')).value)",
  ], { cwd: repoDir });
  assert.equal(sdkSourceValue.trim(), '-canonical-protocol', 'Node source tools also bypass the SDK installed Protocol shadow');
  const admissionEvidence = join(repoDir, 'admission.json');
  await mkdir(join(cliDir, 'src/plugins/projection/registry/sources'), { recursive: true });
  await writeFile(join(cliDir, 'src/plugins/projection/registry/sources/generatedBundledPluginManifests.ts'), `
    import {writeFileSync,readFileSync} from 'node:fs';
    import {join} from 'node:path';
    const token=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN;
    const root=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT;
    const admissionClass=token && root ? readFileSync(join(root,'owners',token.replace(':','-'),'class'),'utf8').trim() : null;
    writeFileSync(${JSON.stringify(admissionEvidence)},JSON.stringify({pid:process.pid,admissionClass}));
    export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];
  `);
  // Observe this builder's class rather than the enclosing test runner's
  // already-admitted validation reservation.
  const buildEnv = {...process.env};
  for (const key of Object.keys(buildEnv)) if (key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')) delete buildEnv[key];
  const result = await buildSourceRuntimeBundle({ repoDir, outputDir: join(repoDir, 'output'), component: 'daemon', env:buildEnv });
  const admitted = JSON.parse(await readFile(admissionEvidence, 'utf8'));
  assert.notEqual(admitted.pid, process.pid, 'source preparation is finite, not part of the long-lived caller');
  if (process.platform === 'linux') assert.equal(admitted.admissionClass, 'source-bundle');
  await writeFile(join(packageDir, 'src/index.ts'), "export const value = 'changed';\n");
  await writeFile(join(cliDir, 'src/lazy.ts'), "throw new Error('moving source was loaded');\n");
  await writeFile(join(unscopedDir, 'src/index.ts'), "throw new Error('moving unscoped source was loaded');\n");
  assert.equal(await (await import(pathToFileURL(result.entrypoint).href)).read(), 'frozen-lazy-unscoped-canonical-protocol');
  assert.equal(await createRequire(import.meta.url)(join(result.cliDir, 'scripts/process_tree.cjs')).read(), 'frozen');
  const publicLibrary = createRequire(join(result.cliDir, 'package.json')).resolve('@happier-dev/cli/lib');
  assert.equal((await import(pathToFileURL(publicLibrary).href)).value, 'frozen-library');
  assert.match(result.identity, /^[a-f0-9]{16}$/);
  const metafile = JSON.parse(await readFile(join(result.runtimeDir, 'metafile.json'), 'utf8'));
  assert.equal(Object.keys(metafile.inputs).some((file) => file.includes('/dist/')), false);
  const rebuilt = await buildSourceRuntimeBundle({ repoDir, outputDir: join(repoDir, 'output-two'), component: 'daemon', env:buildEnv });
  assert.notEqual(rebuilt.identity, result.identity);
});

test('source server refuses reuse of copied SQL consumed during an editor undo', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-source-sql-undo-', registerCleanup: false });
  context.after(async () => { await makeFixtureWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  const serverDir = join(repoDir, 'apps/server');
  await Promise.all(['sources', 'scripts', 'prisma/migrations/example', 'node_modules']
    .map(name => mkdir(join(serverDir, name), { recursive: true })));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'sources/main.ts'), 'export const ready = true;');
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), 'export const migration = true;');
  const prisma = join(serverDir, 'prisma');
  const sql = join(prisma, 'migrations/example/migration.sql');
  await writeFile(sql, 'SELECT 1;\n');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const observer = fixture.path('observe-sql-copy.mjs');
  const marker = fixture.path('edited');
  // Intercept filesystem IO only. The public builder, fingerprint, consumed
  // input recorder and reuse/adoption all remain real.
  await writeFile(observer, `
    import {createRequire,syncBuiltinESMExports} from 'node:module';
    const fs=createRequire(import.meta.url)('node:fs/promises');
    const read=fs.readFile, write=fs.writeFile, copy=fs.cp;
    fs.writeFile=async (...args)=>{
      if (String(args[0]).replaceAll('\\\\','/').endsWith('/apps/server/package.json')
        && String(args[0])!==${JSON.stringify(join(serverDir, 'package.json'))}
        && !(await fs.access(${JSON.stringify(marker)}).then(()=>true,()=>false))) {
        await write(${JSON.stringify(marker)},'edited');
        await write(${JSON.stringify(sql)},'SELECT 2;\\n');
      }
      return write(...args);
    };
    fs.readFile=async (...args)=>{
      const contents=await read(...args);
      if (String(args[0])===${JSON.stringify(sql)} && String(contents)==='SELECT 2;\\n')
        await write(${JSON.stringify(sql)},'SELECT 1;\\n');
      return contents;
    };
    fs.cp=async (...args)=>{
      const result=await copy(...args);
      if (String(args[0])===${JSON.stringify(prisma)}) await write(${JSON.stringify(sql)},'SELECT 1;\\n');
      return result;
    };
    syncBuiltinESMExports();
  `);
  const native = process.platform === 'linux' ? await installSourceAdmissionFixture(fixture.root) : null;
  const build = native?.build ?? buildSourceRuntimeBundle;
  const env = { ...(native?.env ?? process.env), NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(observer).href}`.trim() };
  await installSourcePreparationInputs(repoDir, 'server');
  const options = { repoDir, stackBaseDir: fixture.path('stacks/server'), component: 'server',
    serverComponent: 'happier-server', dbProvider: 'postgres', env };
  const first = await build(options);
  assert.equal(await readFile(join(first.serverDir, 'prisma/migrations/example/migration.sql'), 'utf8'), 'SELECT 2;\n');
  assert.equal(await readFile(sql, 'utf8'), 'SELECT 1;\n', 'source was restored before reuse admission');
  const second = await build(options);
  assert.equal(await readFile(join(second.serverDir, 'prisma/migrations/example/migration.sql'), 'utf8'), 'SELECT 1;\n',
    'the restored source must not adopt the bundle containing transient SQL');
  assert.notEqual(second.entrypoint, first.entrypoint);
  assert.equal((await build(options)).entrypoint, second.entrypoint, 'settled SQL keeps warm reuse');
});

test('source server retains migration source assets without copying checkout database files', async (context) => {
  const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-runtime-'));
  context.after(() => rm(repoDir, { recursive: true, force: true }));
  const serverDir = join(repoDir, 'apps/server');
  await Promise.all(['sources', 'scripts', 'prisma/migrations/example', 'node_modules'].map((name) => mkdir(join(serverDir, name), { recursive: true })));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  await writeFile(join(serverDir, 'sources/main.ts'), 'export const ready = true;\n');
  await writeFile(join(serverDir, 'scripts/migrate.full.deploy.ts'), 'export const migration = true;\n');
  await writeFile(join(serverDir, 'prisma/schema.prisma'), 'datasource db {}\n');
  await writeFile(join(serverDir, 'prisma/migrations/migration_lock.toml'), 'provider = "postgresql"\n');
  await writeFile(join(serverDir, 'prisma/migrations/example/migration.sql'), 'SELECT 1;\n');
  await writeFile(join(serverDir, 'prisma/development.db'), 'private retained checkout data');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  const runtime = await buildSourceRuntimeBundle({ repoDir, outputDir: join(repoDir, 'output'), component: 'server', serverComponent: 'happier-server', dbProvider: 'postgres' });
  const stackBaseDir = join(repoDir, 'stacks/server');
  await mkdir(join(stackBaseDir, 'source-runtime'), {recursive:true});
  await writeFile(join(stackBaseDir, 'source-runtime/selected-server.json'), JSON.stringify({entrypoint:runtime.entrypoint}));
  await writeFile(join(serverDir, 'sources/main.ts'), 'import "./missing-moving-source";');
  const recovered = await buildSourceRuntimeBundle({repoDir, stackBaseDir, component:'server', reuseSelected:true});
  assert.deepEqual(recovered, runtime, 'server recovery preserves emitted code, environment and migration launch together');
  assert.equal(await readFile(join(runtime.serverDir, 'prisma/schema.prisma'), 'utf8'), 'datasource db {}\n');
  assert.equal(await readFile(join(runtime.serverDir, 'prisma/migrations/example/migration.sql'), 'utf8'), 'SELECT 1;\n');
  assert.equal(await readFile(join(runtime.serverDir, 'prisma/migrations/migration_lock.toml'), 'utf8'), 'provider = "postgresql"\n');
  await assert.rejects(access(join(runtime.serverDir, 'prisma/development.db')), { code: 'ENOENT' });
});

test('Node source-light runs the canonical SQLite migration before startup without losing retained data', async context => {
  const fixture = await createTempFixture(context, {prefix:'happier-source-light-migration-', registerCleanup:false});
  context.after(async () => {
    await makeFixtureWritable(fixture.root);
    await rm(fixture.root, {recursive:true, force:true});
  });
  await mkdir(fixture.path('repo'));
  await linkCanonicalServerWorkspace(fixture.path('repo'));
  const serverDir = fixture.path('repo/apps/server');
  const migrationName = '20260927010000_add_home_settings_and_administration_events';
  const canonicalDeploy = fileURLToPath(new URL('../../../server/scripts/migrate.sqlite.deploy.ts', import.meta.url));
  const canonicalMigrations = fileURLToPath(new URL('../../../server/prisma/sqlite/migrations', import.meta.url));
  await Promise.all(['sources', 'scripts', `prisma/sqlite/migrations/${migrationName}`, 'node_modules']
    .map(name => mkdir(join(serverDir, name), {recursive:true})));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({name:'@happier-dev/server', type:'module'}));
  await writeFile(join(serverDir, 'tsconfig.json'), JSON.stringify({
    extends:fileURLToPath(new URL('../../../server/tsconfig.json', import.meta.url)),
  }));
  await writeFile(join(serverDir, 'sources/main.light.ts'), 'export const ready = true;');
  // Re-export the actual deployment owner; no migration-domain logic is mocked.
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'),
    `export {runSqliteMigrationDeploy} from ${JSON.stringify(canonicalDeploy)};`);
  await cp(canonicalMigrations, join(serverDir, 'prisma/sqlite/migrations'), {recursive:true});
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')),
    join(serverDir, 'node_modules/esbuild'), process.platform === 'win32' ? 'junction' : 'dir');
  await installSourcePreparationInputs(fixture.path('repo'), 'server');
  const runtime = await buildSourceRuntimeBundle({repoDir:fixture.path('repo'), stackBaseDir:fixture.path('stacks/consumer'),
    component:'server', serverComponent:'happier-server-light', dbProvider:'sqlite'});
  assert.equal(runtime.migration.mode, 'external', 'Node cannot perform the Bun-only in-process migration');
  const dataDir = fixture.path('retained-data');
  await mkdir(dataDir);
  const databasePath = join(dataDir, 'retained.sqlite');
  const execute = promisify(execFile);
  await execute(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    db.exec("CREATE TABLE Retained (value TEXT NOT NULL); INSERT INTO Retained VALUES ('keep');");db.close();
  `, databasePath]);
  const env = {...process.env, ...runtime.env, HAPPIER_SERVER_LIGHT_DATA_DIR:dataDir,
    DATABASE_URL:`file:${databasePath}`};
  const serverLaunchSpec = resolveServerRuntimeLaunchSpec({sourceRuntimeLaunch:runtime});
  const children = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    await runServerRuntimeMigration({serverLaunchSpec, env, children});
  }
  assert.deepEqual(children, []);
  const observed = await execute(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);
    console.log(JSON.stringify({retained:db.prepare('SELECT value FROM Retained').get().value,
      homeSettings:db.prepare('SELECT count(*) AS count FROM HomeSettings').get().count,
      migrations:db.prepare('SELECT count(*) AS count FROM _prisma_migrations WHERE migration_name=?').get(process.argv[2]).count}));
    db.close();
  `, databasePath, migrationName]);
  assert.deepEqual(JSON.parse(observed.stdout), {retained:'keep', homeSettings:0, migrations:1});
});

test('cancelling source author emission retires its declaration compiler',
  { skip: process.platform !== 'linux', timeout: 20000 }, async context => {
    const fixture = await createTempFixture(context, {prefix:'happier-source-author-cancel-'});
    const repoDir = fixture.path('repo');
    const cliDir = join(repoDir, 'apps/cli');
    const sdkDir = join(repoDir, 'packages/plugin-sdk');
    for (const directory of [join(cliDir, 'src'), join(cliDir, 'node_modules'),
      join(sdkDir, 'src'), join(repoDir, 'node_modules/@happier-dev')]) {
      await mkdir(directory, {recursive:true});
    }
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({name:'@happier-dev/cli',type:'module',
      dependencies:{'@happier-dev/plugin-sdk':'0.0.0'},bundledDependencies:['@happier-dev/plugin-sdk'],exports:{}}));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await writeFile(join(cliDir, 'src/index.ts'), 'export const ready=true;');
    await writeFile(join(sdkDir, 'package.json'), JSON.stringify({name:'@happier-dev/plugin-sdk',version:'0.0.0',
      type:'module',main:'./dist/index.js',types:'./dist/index.d.ts',
      exports:{'.':{'happier-source':'./src/index.ts',types:'./dist/index.d.ts',default:'./dist/index.js'}},
      happier:{publicSdkRelease:{posture:'developer_preview'}}}));
    await writeFile(join(sdkDir, 'tsconfig.json'), JSON.stringify({compilerOptions:{target:'ES2022',
      module:'NodeNext',moduleResolution:'NodeNext',rootDir:'src',outDir:'dist',declaration:true},include:['src/**/*.ts']}));
    await writeFile(join(sdkDir, 'src/index.ts'), 'export const author=true;');
    await symlink(sdkDir, join(repoDir, 'node_modules/@happier-dev/plugin-sdk'));
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'));
    const ready = fixture.path('active-compiler.json');
    const heldCompiler = fixture.path('held-compiler.mjs');
    // Only the external compiler tool is substituted. Keep source preparation,
    // admission and foreground process custody on their real internal paths.
    await writeFile(heldCompiler, `import {writeFileSync,renameSync} from 'node:fs';
      writeFileSync(${JSON.stringify(ready+'.tmp')},JSON.stringify({pid:process.pid}));
      renameSync(${JSON.stringify(ready+'.tmp')},${JSON.stringify(ready)});
      setInterval(()=>{},1000);`);
    const compilerPath = resolveTypeScriptCliInvocation({args:[]}).compilerPath;
    const observer = fixture.path('hold-compiler.mjs');
    await writeFile(observer, `import {createRequire,syncBuiltinESMExports} from 'node:module';
      const childProcess=createRequire(import.meta.url)('node:child_process');
      const spawn=childProcess.spawn;
      childProcess.spawn=function(command,args,...options) {
        return spawn.call(this,command,args?.map(arg=>arg===${JSON.stringify(compilerPath)}?${JSON.stringify(heldCompiler)}:arg),...options);
      };
      syncBuiltinESMExports();`);
    let compilerPid;
    context.after(() => {
      // A RED result must not leak this test's deliberately held OS process.
      if (compilerPid) {
        try { process.kill(compilerPid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    });
    const watcher = watch(fixture.root);
    context.after(() => watcher.close());
    const active = new Promise((resolve,reject) => {
      watcher.on('error',reject);
      watcher.on('change',(_event,filename) => { if (filename==='active-compiler.json') resolve(); });
    });
    const controller = new AbortController();
    const pending = buildSourceRuntimeBundle({repoDir,outputDir:fixture.path('output'),component:'daemon',
      signal:AbortSignal.any([controller.signal,context.signal]),env:{...process.env,
        NODE_OPTIONS:`${process.env.NODE_OPTIONS??''} --import=${pathToFileURL(observer).href}`.trim()}});
    const cancelled = assert.rejects(pending,{name:'AbortError'});
    await active;
    compilerPid = JSON.parse(await readFile(ready,'utf8')).pid;
    controller.abort();
    await cancelled;
    let alive = true;
    for (let attempt=0;attempt<100;attempt++) {
      try { alive=!(await readFile(`/proc/${compilerPid}/status`,'utf8')).match(/^State:\s+Z/m); }
      catch (error) { if (error.code!=='ENOENT') throw error; alive=false; }
      if (!alive) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(alive,false,'the declaration compiler survived source preparation cancellation');
  });

for (const shared of [false,true]) test(`cancelling ${shared ? 'shared' : 'admitted'} source preparation retires its active worker and native service`,
  { skip: process.platform !== 'linux', timeout: 20000 }, async (context) => {
    const repoDir = await mkdtemp(join(tmpdir(), 'happier-source-cancel-'));
    let worker;
    context.after(async () => {
      // A failing cancellation assertion must not leave this fixture's real
      // builder/service alive. Authenticate its fixture command before killing.
      if(worker) {
        try {
          if((await readFile(`/proc/${worker.pid}/cmdline`,'utf8')).includes(repoDir)) process.kill(worker.pid,'SIGTERM');
        } catch(error) { if(error.code!=='ENOENT' && error.code!=='ESRCH') throw error; }
      }
      await makeFixtureWritable(repoDir);
      await rm(repoDir, {recursive:true,force:true});
    });
    const cliDir = join(repoDir, 'apps/cli');
    const locatorDir = join(cliDir, 'src/plugins/projection/registry/sources');
    await mkdir(locatorDir, { recursive: true });
    await mkdir(join(cliDir, 'node_modules'));
    await writeFile(join(cliDir, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', type: 'module', exports: {} }));
    await writeFile(join(cliDir, 'tsconfig.json'), '{}');
    await writeFile(join(cliDir, 'src/index.ts'), 'export const ready=true;');
    await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(cliDir, 'node_modules/esbuild'));
    const ready = join(repoDir, 'active-worker.json');
    // The canonical locator transform has already started the real esbuild
    // service. Hold its fixture module so cancellation reaches an active build.
    await writeFile(join(locatorDir, 'generatedBundledPluginManifests.ts'), `
      import {writeFileSync,readFileSync,renameSync} from 'node:fs';
      setInterval(()=>{},1000);
      writeFileSync(${JSON.stringify(ready + '.tmp')},JSON.stringify({pid:process.pid,children:readFileSync('/proc/'+process.pid+'/task/'+process.pid+'/children','utf8').trim().split(/\\s+/).filter(Boolean).map(Number)}));
      renameSync(${JSON.stringify(ready + '.tmp')},${JSON.stringify(ready)});
      await new Promise(()=>{});
      export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];
    `);
    const watcher = watch(repoDir);
    context.after(() => watcher.close());
    const active = new Promise((resolve, reject) => {
      watcher.on('error', reject);
      watcher.on('change', (_event, filename) => { if (filename === 'active-worker.json') resolve(); });
    });
    const controller = new AbortController();
    const native = await installSourceAdmissionFixture(repoDir);
    const pending = native.build({ repoDir,
      ...(shared ? {stackBaseDir:join(repoDir,'stacks/consumer')} : {outputDir:join(repoDir,'output')}),
      component:'daemon', env:native.env, signal:controller.signal });
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    await active;
    worker = JSON.parse(await readFile(ready, 'utf8'));
    assert.notEqual(worker.pid, process.pid);
    assert.ok(worker.children.length, 'the worker has started its real native service');
    controller.abort();
    await cancelled;
    // Wait only for the kernel to expose the already-requested child exit.
    for (const pid of [worker.pid, ...worker.children]) {
      let alive = true;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { alive = !(await readFile(`/proc/${pid}/status`, 'utf8')).match(/^State:\s+Z/m); }
        catch (error) { if (error.code !== 'ENOENT') throw error; alive = false; }
        if (!alive) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(alive, false, `source preparation child ${pid} survived cancellation`);
    }
    if(shared) await assert.rejects(access(join(repoDir,'stacks/source-bundles/build.lock')),{code:'ENOENT'});
    assert.deepEqual(await readdir(join(native.admissionRoot,'owners')),[]);
    assert.deepEqual(await readdir(join(native.admissionRoot,'waiters')),[]);
    if(shared) {
      await writeFile(join(locatorDir,'generatedBundledPluginManifests.ts'),
        'export const BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS=[];');
      const replacement = await native.build({repoDir,stackBaseDir:join(repoDir,'stacks/consumer'),
        component:'daemon',env:native.env,signal:context.signal});
      assert.equal((await import(pathToFileURL(replacement.entrypoint))).ready,true);
      assert.equal((await readdir(join(repoDir,'stacks/source-bundles'))).filter(name=>name.startsWith('bundle-')).length,1,
        'a later publication reclaims the cancelled producer without reclaiming active producers');
    }
  });
