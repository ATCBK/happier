import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { run } from '../utils/proc/proc.mjs';
import { exportSourceWebUi } from './build_source_web_ui.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv, installNativeAdmissionFixture } from '../testkit/core/native_admission_fixture.mjs';
import { captureSourceWebBuildInputs, readWorkspacePackages, setBundleReadOnly, withSourceBundlePublication } from './build_source_runtime.mjs';
import { ensureExpoWorkspacePrepared, hasUsableExpoWorkspaceLastGreen, withExpoPreparationEnv } from '../utils/expo/command.mjs';
import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';
import { sanitizeStackTestRunnerEnv } from '../utils/test/test_env.mjs';
import { recordStackRuntimeStart, readStackRuntimeStateFile } from '../utils/stack/runtime_state.mjs';
import { beginPendingSourceStart } from '../runtime/shared/pending_source_start.mjs';
import { withDependencyRefreshLock } from '../utils/proc/dependency_refresh.mjs';
import { withPatchedProcessEnv } from '../testkit/core/env_scope.mjs';

test('captured Metro crawls workspace-local installed dependencies', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-captured-metro-dependencies-', registerCleanup: false });
  let metro;
  t.after(async () => { await metro?.end(); await fixture.cleanup(); });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('source');
  await prepareFiniteSourceWebFixture({ sourceRepo, repoDir });
  const uiPackagePath = join(repoDir, 'apps/ui/package.json');
  const uiPackage = JSON.parse(await readFile(uiPackagePath, 'utf8'));
  delete uiPackage.type; // The production Metro config is CommonJS.
  await writeFile(uiPackagePath, JSON.stringify(uiPackage));
  const dependencies = ['apps/ui/node_modules/@capture-fixture/local/index.js',
    'apps/ui/node_modules/capture-local/index.js', 'node_modules/capture-root/index.js'];
  for (const dependency of dependencies) {
    await mkdir(dirname(join(repoDir, dependency)), { recursive: true });
    await writeFile(join(repoDir, dependency), 'module.exports = "installed-dependency";');
  }
  const capture = await captureSourceWebBuildInputs({ repoDir, outputDir: fixture.path('capture') });
  const require = createRequire(join(capture.uiProjectDir, 'package.json'));
  withPatchedProcessEnv(t, { HAPPIER_UI_METRO_NARROW_WATCH_FOLDERS: '1', EXPO_NO_METRO_WORKSPACE_ROOT: '1' });
  const config = require('./metro.config.js');
  for (const directory of ['apps/docs', 'packages/tests']) assert.equal(
    config.watchFolders.includes(join(sourceRepo, directory)), false,
    'installed workspace aliases must not add unrelated authored source roots');
  const installedFiles = await Promise.all(dependencies.map(dependency => realpath(join(capture.repoDir, dependency))));
  // Restrict this file-map check to the roots chosen by the real config that
  // can contain this dependency; it needs no transform or unrelated UI graph.
  const contains = (root, file) => {
    const path = relative(root, file);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  const roots = [config.projectRoot, ...config.watchFolders].filter(root => installedFiles.some(file => contains(root, file)));
  for (const file of installedFiles) assert.ok(roots.some(root => contains(root, file)),
    'resolved workspace-local and root bytes must be inside Metro crawl roots');
  config.watchFolders = roots;
  config.maxWorkers = 1;
  config.resolver.useWatchman = false;
  config.fileMapCacheDirectory = fixture.path('metro-cache');
  await mkdir(config.fileMapCacheDirectory);
  config.reporter = { update() {} };
  metro = await require('metro').createConnectMiddleware(config, { watch: false, waitForBundler: true });
  const graph = await metro.metroServer.getBundler().getBundler().getDependencyGraph();
  for (const file of installedFiles) assert.equal((await graph.getOrComputeSha1(file)).sha1,
    createHash('sha1').update(await readFile(file)).digest('hex'));
});

test('unchanged source export failure is terminal despite a Metro source diagnostic', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-unchanged-failure-' });
  const repoDir = fixture.path('repo');
  const { uiInput, uiSource } = await prepareFiniteSourceWebFixture({
    sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir,
  });
  const failure = Object.assign(new Error('Failed to get the SHA-1 for: installed/index.js (file is not watched)'),
    { code: 1, sourceDrift: true });
  let attempts = 0;
  const cancellation = new AbortController();
  let deadline;
  t.after(() => clearTimeout(deadline));
  await assert.rejects(exportSourceWebUi({ repoDir, baseDir: fixture.path('state'), outputDir: fixture.path('export'), signal: cancellation.signal,
    env: { ...process.env, EXPO_PUBLIC_DEBUG: '0' },
    runImpl: async () => {
      attempts++;
      await writeFile(uiInput, uiSource); // A new timestamp with identical bytes is not source drift.
      deadline ??= setTimeout(() => cancellation.abort(new Error('unchanged export kept waiting for source edits')), 30000);
      throw failure;
    } }), error => {
    assert.equal(error, failure, 'unchanged source must expose the original Metro error without waiting for edits');
    assert.equal(error.sourceDrift, false);
    return true;
  });
  assert.equal(attempts, 1);
});

test('source export retries a failed attempt only after authored input bytes changed', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-changed-failure-' });
  const repoDir = fixture.path('repo');
  const { uiInput } = await prepareFiniteSourceWebFixture({
    sourceRepo: fileURLToPath(new URL('../../../../', import.meta.url)), repoDir,
  });
  let attempts = 0;
  const cancellation = new AbortController();
  let deadline;
  t.after(() => clearTimeout(deadline));
  const built = await exportSourceWebUi({ repoDir, baseDir: fixture.path('state'), outputDir: fixture.path('export'),
    signal: cancellation.signal, env: { ...process.env, EXPO_PUBLIC_DEBUG: '0' },
    runImpl: async (_command, args, { cwd }) => {
      if (++attempts === 1) {
        deadline = setTimeout(() => cancellation.abort(), 180000);
        await writeFile(uiInput, 'export const changed = true;');
        throw Object.assign(new Error('Metro export failed while inputs moved'), { code: 1 });
      }
      assert.equal(await readFile(join(cwd, 'sources/app/_layout.tsx'), 'utf8'), 'export const changed = true;');
      const web = args[args.indexOf('--output-dir') + 1];
      await mkdir(web);
      await writeFile(join(web, 'index.html'), '<script src="./app.js"></script>');
      await writeFile(join(web, 'app.js'), 'globalThis.changed = true;');
    } });
  assert.equal(attempts, 2);
  assert.equal(await readFile(join(built.uiDir, 'app.js'), 'utf8'), 'globalThis.changed = true;');
});

test('stack web source reload preserves other roles when the served export is unavailable', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-web-reload-command-' });
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const stackName = 'source-ui';
  const baseDir = fixture.path('stacks', stackName);
  await mkdir(baseDir, { recursive: true });
  await writeFile(join(baseDir, 'env'), `HAPPIER_STACK_REPO_DIR=${repoDir}\nHAPPIER_STACK_SERVER_PORT=3005\n`);
  const entrypoint = fixture.path('incumbent.mjs');
  await writeFile(entrypoint, 'export const incumbent = true;');
  const sourceRuntimeLaunch = { entrypoint, cliDir: join(repoDir, 'apps/cli') };
  const identities = { server: { selected: 'server', loaded: 'server' }, daemon: { selected: 'daemon', loaded: 'daemon' } };
  await recordStackRuntimeStart(join(baseDir, 'stack.runtime.json'), { stackName, ownerPid: process.pid,
    runtimeMode: 'source-snapshot', sourceUi: 'export', sourceUiLaunch: { uiDir: fixture.path('missing-web') },
    sourceRuntimeLaunch, sourceRuntimeIdentities: identities, placement: { server: 'local', daemon: 'local' } });
  const env = { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
    HAPPIER_DEV_TARGET_EXECUTION: '0', HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0' };
  const result = await runNodeCapture([join(repoDir, 'apps/stack/bin/hstack.mjs'), 'stack', 'build', stackName,
    '--web', '--runtime=source', '--json'], { cwd: repoDir, env });
  assert.notEqual(result.code, 0);
  const observed = await readStackRuntimeStateFile(join(baseDir, 'stack.runtime.json'));
  assert.deepEqual(observed.sourceRuntimeLaunch, sourceRuntimeLaunch);
  assert.deepEqual(observed.sourceRuntimeIdentities, identities);
  await assert.rejects(access(join(baseDir, 'source-runtime/selected-daemon.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(baseDir, 'runtime/artifacts')), { code: 'ENOENT' });
});

test('source stacks reuse completed web bytes while debug options and damaged exports require construction', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-completed-source-web-', registerCleanup: false });
  let pending;
  let otherPending;
  context.after(async () => {
    await otherPending?.dispose();
    await pending?.dispose();
    await setBundleReadOnly(fixture.root, false);
    await fixture.cleanup();
  });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('repo');
  // The fixture owns its authored changes. Other lanes may keep editing the
  // shared checkout without turning this unchanged-input assertion into churn.
  await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: repoDir });
  const stackBaseDir = fixture.path('stacks/consumer');
  const counter = fixture.path('exports');
  const expo = fixture.path(process.platform === 'win32' ? 'expo.cmd' : 'expo');
  await writeFile(expo, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fixture.path('expo.mjs')}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${fixture.path('expo.mjs')}' "$@"\n`);
  await chmod(expo, 0o755);
  await writeFile(fixture.path('expo.mjs'), `
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const count=Number(await readFile(${JSON.stringify(counter)},'utf8').catch(()=>0))+1;
await writeFile(${JSON.stringify(counter)},String(count));
await access(join(process.cwd(),'sources/app/_layout.tsx'));
if(process.env.EXPO_PUBLIC_FEATURES==='different') throw new Error('ENOSPC: test export boundary');
const web=process.argv[process.argv.indexOf('--output-dir')+1];
await mkdir(web,{recursive:true});
await writeFile(join(web,'index.html'),'<html><body><main id="root"></main><script src="./app.js"></script></body></html>');
await writeFile(join(web,'app.js'),'globalThis.debug = '+JSON.stringify(process.env.EXPO_PUBLIC_DEBUG)+';document.getElementById("root").textContent="Completed fixture export rendered";');
`);
  const commandBoundary = fixture.path('expo-command.mjs');
  await writeFile(commandBoundary, `export {prepareExpoCommandEnv,applyExpoExportMaxWorkersArgs} from ${JSON.stringify(new URL('../utils/expo/command.mjs', import.meta.url).href)};\nexport async function resolveExpoBin(){return ${JSON.stringify(expo)};}`);
  const sourceUrl = new URL('./build_source_web_ui.mjs', import.meta.url);
  const publicOwner = fixture.path('source-web.mjs');
  const native = process.platform === 'linux' ? await installNativeAdmissionFixture({ root: fixture.root }) : null;
  const adapterSource = new URL('../utils/proc/runSourceBuildCommand.mjs', import.meta.url);
  const adapter = native && fixture.path('native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
  if (adapter) await writeFile(adapter, (await readFile(adapterSource, 'utf8')).replace(
    "from '../dev/devReloadCoordinator.mjs'", `from ${JSON.stringify(new URL('../dev/devReloadCoordinator.mjs', adapterSource).href)}`));
  // Substitute only installed executable lookup. The subprocess producer,
  // capture, SDK preparation, admission, cache and publication remain real.
  // The isolated physical admission fixture lets independent cold producers
  // queue together, without inheriting the already-charged test runner host.
  await writeFile(publicOwner, (await readFile(sourceUrl, 'utf8'))
    .replace("fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url))", JSON.stringify(native?.launcher ?? fileURLToPath(new URL('../../bin/hstack-exec', sourceUrl))))
    .replace(/from '(\.[^']+)'/g, (_match, specifier) => {
      const url = specifier === '../utils/expo/command.mjs' ? pathToFileURL(commandBoundary)
        : adapter && specifier === '../utils/proc/runSourceBuildCommand.mjs' ? pathToFileURL(adapter) : new URL(specifier, sourceUrl);
      return `from ${JSON.stringify(url.href)}`;
    }));
  const { exportSourceWebUi: exportShared, publishSourceWebUi: selectShared } = await import(pathToFileURL(publicOwner));
  pending = await beginPendingSourceStart({ stackBaseDir });
  const exports = async () => Number(await readFile(counter, 'utf8'));
  const env = { ...(native ? buildNativeAdmissionFixtureEnv() : process.env), EXPO_PUBLIC_DEBUG: '0' };
  const options = { repoDir, stackBaseDir, pending, baseDir: fixture.path('state'),
    env };
  const otherStackBaseDir = fixture.path('stacks/independent');
  otherPending = await beginPendingSourceStart({ stackBaseDir: otherStackBaseDir });
  const completed = await Promise.allSettled([
    exportShared({ ...options, outputDir: fixture.path('first') }),
    exportShared({ ...options, stackBaseDir: otherStackBaseDir, pending: otherPending, baseDir: fixture.path('independent-state') }),
  ]);
  const [first, other] = completed.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  const repeat = await exportShared({ ...options, outputDir: fixture.path('second') });
  assert.equal(await exports(), 1, 'an unchanged restart must skip Metro and plugin preparation');
  assert.equal(repeat.uiDir, first.uiDir, 'restart selects the completed export without copying or mutating it');
  assert.equal(other.uiDir, first.uiDir, 'independent Stack homes share account-free completed bytes');
  // Already-loaded source publishers nominate bundle-* allocations and do
  // not know serving web references. Their observed namespace must not include
  // a new completed web product, even after its own build lease has retired.
  const legacyCandidates = (await readdir(fixture.path('stacks/source-bundles')))
    .filter(name => name.startsWith('bundle-')).map(name => fixture.path('stacks/source-bundles', name));
  assert.equal(legacyCandidates.includes(dirname(first.uiDir)), false,
    'an older loaded source retainer must not nominate shared serving web bytes');
  assert.equal(await exports(), 1);
  const firstServing = fixture.path('stacks/consumer/source-runtime/ui');
  const otherServing = fixture.path('stacks/independent/source-runtime/ui');
  await selectShared({ built: first, uiDir: firstServing, pending });
  await selectShared({ built: other, uiDir: otherServing, pending: otherPending });
  const debug = await exportShared({ ...options, outputDir: fixture.path('debug'),
    env: { ...options.env, EXPO_PUBLIC_DEBUG: '1' } });
  assert.equal(await exports(), 2);
  assert.notEqual(debug.uiDir, first.uiDir);
  assert.match(await readFile(join(debug.uiDir, 'app.js'), 'utf8'), /"1"/);
  await selectShared({ built: debug, uiDir: firstServing, pending });
  assert.match(await readFile(join(firstServing, 'app.js'), 'utf8'), /"1"/);
  assert.match(await readFile(join(otherServing, 'app.js'), 'utf8'), /"0"/,
    'a web-only reload changes this Stack serving link without changing another consumer');
  await chmod(join(first.uiDir, 'app.js'), 0o644);
  await writeFile(join(first.uiDir, 'app.js'), 'damaged');
  const repaired = await exportShared({ ...options, outputDir: fixture.path('repair') });
  assert.equal(await exports(), 3, 'a content-damaged completed export is not reusable');
  assert.match(await readFile(join(repaired.uiDir, 'app.js'), 'utf8'), /"0"/);
  await assert.rejects(exportShared({ ...options, outputDir: fixture.path('failure'),
    env: { ...options.env, EXPO_PUBLIC_DEBUG: '1', EXPO_PUBLIC_FEATURES: 'different' } }), /ENOSPC/);
  const afterFailure = await exportShared({ ...options, outputDir: fixture.path('after-failure') });
  assert.equal(afterFailure.uiDir, repaired.uiDir, 'a failed distinct export cannot replace the incumbent');
  assert.equal(await exports(), 4);
  const terminal = await exportShared({ ...options,
    env: { ...options.env, HAPPIER_TERMINAL_NATIVE_BUILD_EVIDENCE_ID: 'term-build-distinct-options' } });
  assert.notEqual(terminal.uiDir, repaired.uiDir, 'app configuration options participate in reuse');
  assert.equal(await exports(), 5);
  const member = join(repoDir, 'apps/ui/sources/completedWebMembership.ts');
  await writeFile(member, 'export const added = true;');
  const changed = await exportShared(options);
  assert.notEqual(changed.uiDir, repaired.uiDir, 'new authored membership invalidates a completed export');
  assert.equal(await exports(), 6);
  await rm(member);
  assert.equal((await exportShared(options)).uiDir, repaired.uiDir, 'Undo adopts matching captured bytes');
  assert.equal(await exports(), 6);
  const fault = fixture.path('completion-fault.mjs');
  // Fail only the real output-completion rename; no cache/publication logic
  // or domain owner is substituted beneath the filesystem boundary.
  await writeFile(fault, `import fs from 'node:fs/promises'; import {syncBuiltinESMExports} from 'node:module';
    import {basename} from 'node:path'; const rename=fs.rename;
    fs.rename=async(from,to)=>{if(basename(to)==='source-bundle.json')throw Object.assign(new Error('ENOSPC at web completion'),{code:'ENOSPC'});return rename(from,to)};
    syncBuiltinESMExports();`);
  const servingBytes = await readFile(join(firstServing, 'app.js'), 'utf8');
  await assert.rejects(exportShared({ ...options, env: { ...options.env, EXPO_PUBLIC_FEATURES: 'publication-failure',
    NODE_OPTIONS: [options.env.NODE_OPTIONS, `--import=${pathToFileURL(fault).href}`].filter(Boolean).join(' ') } }), /ENOSPC at web completion/);
  assert.equal(await readFile(join(firstServing, 'app.js'), 'utf8'), servingBytes);
  assert.equal((await exportShared(options)).uiDir, repaired.uiDir, 'failed completion keeps reusable incumbent bytes');
  assert.equal(await exports(), 7);

  const privateExport = await exportShared({ ...options, stackBaseDir: undefined, pending: undefined,
    outputDir: fixture.path('private-export') });
  assert.equal(await exports(), 8, 'the private finite producer must execute its own Expo boundary');
  assert.match(await readFile(join(privateExport.uiDir, 'app.js'), 'utf8'), /"0"/);

  const artifactSource = new URL('./build_web_artifact.mjs', import.meta.url);
  const artifactOwnerPath = fixture.path('artifact.mjs');
  await writeFile(artifactOwnerPath, (await readFile(artifactSource, 'utf8'))
    .replace(/from '(\.[^']+)'/g, (_match, specifier) => {
      const url = specifier === './build_source_web_ui.mjs' ? pathToFileURL(publicOwner)
        : specifier === '../utils/expo/command.mjs' ? pathToFileURL(commandBoundary)
          : adapter && specifier === '../utils/proc/runSourceBuildCommand.mjs' ? pathToFileURL(adapter)
            : new URL(specifier, artifactSource);
      return `from ${JSON.stringify(url.href)}`;
    }));
  const { buildWebArtifact } = await import(pathToFileURL(artifactOwnerPath));
  const artifact = await buildWebArtifact({ rootDir: repoDir, artifactDir: fixture.path('artifacts/web/finite'),
    artifactFingerprint: 'finite', sourceMetadata: { sourceFingerprint: 'fixture', builtAt: '2026-10-12T00:00:00Z' },
    env: { ...env, HAPPIER_STACK_REPO_DIR: repoDir, HAPPIER_STACK_HOME_DIR: fixture.path('home') },
    // Installation is the package-manager boundary. Capture, SDK preparation,
    // finite admission, Expo execution and artifact publication remain real.
    ensureDepsInstalledImpl: async (_dir, _label, options) => await options.onDependenciesReady(),
    runUiPostinstallImpl: () => {} });
  assert.equal(await exports(), 9);
  assert.match(await readFile(join(artifact.artifactDir, 'payload/app.js'), 'utf8'), /"0"/);
  assert.deepEqual(await readdir(fixture.path('artifacts/web')), ['finite']);

  // Compose the real reload owner with the same source fixture/store. Only
  // the already-used Expo executable and physical admission host are remapped;
  // runtime emission, scratch migration/health and browser boot stay real.
  let browserAvailable = false;
  try { execFileSync('agent-browser', ['--version'], { stdio: 'ignore' }); browserAvailable = true; } catch {}
  if (!native || !browserAvailable) {
    context.diagnostic('composed source web reload not exercised: native admission/browser prerequisites unavailable');
    return;
  }
  const serverDir = join(repoDir, 'apps/server');
  await mkdir(join(serverDir, 'sources'), { recursive: true });
  await mkdir(join(serverDir, 'scripts'));
  await mkdir(join(serverDir, 'node_modules'));
  await writeFile(join(serverDir, 'package.json'), JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await writeFile(join(serverDir, 'tsconfig.json'), '{}');
  await writeFile(join(serverDir, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(serverDir, 'node_modules/esbuild'));
  await writeFile(join(serverDir, 'sources/main.light.ts'), `
    import {createServer} from 'node:http'; import {readFile} from 'node:fs/promises'; import {join} from 'node:path';
    createServer(async(request,response)=>{
      if(request.url==='/health') {response.setHeader('content-type','application/json');response.end(JSON.stringify({status:'ok',service:'happier-server'}));return;}
      const asset=request.url==='/'?'index.html':'app.js';
      try {response.setHeader('content-type',asset.endsWith('.js')?'text/javascript':'text/html');response.end(await readFile(join(process.env.HAPPIER_SERVER_UI_DIR,asset)));}
      catch {response.statusCode=404;response.end();}
    }).listen(Number(process.env.PORT),process.env.HOST);
  `);
  const runtimeSource = new URL('./build_source_runtime.mjs', import.meta.url);
  const runtimePath = fixture.path('native-owner/apps/stack/scripts/build/build_source_runtime.mjs');
  await mkdir(dirname(runtimePath), { recursive: true });
  await writeFile(runtimePath, (await readFile(runtimeSource, 'utf8')).replace(/^(import|export) ([^\n]*) from '(\.[^']+)'/gm, (match, declaration, clause, specifier) => {
    if (['../utils/proc/runSourceBuildCommand.mjs', '../utils/proc/workspace_build_admission.mjs'].includes(specifier)) return match;
    return `${declaration} ${clause} from ${JSON.stringify(new URL(specifier, runtimeSource).href)}`;
  }));
  const smokeSource = new URL('../runtime/launch/smokeSourceRuntimeReload.mjs', import.meta.url);
  const smokePath = fixture.path('native-owner/apps/stack/scripts/runtime/launch/smokeSourceRuntimeReload.mjs');
  await mkdir(dirname(smokePath), { recursive: true });
  await writeFile(smokePath, (await readFile(smokeSource, 'utf8')).replace(/from '(\.[^']+)'/g,
    (_match, specifier) => `from ${JSON.stringify(new URL(specifier, smokeSource).href)}`));
  const reloadSource = new URL('../runtime/launch/prepareSourceRuntimeReload.mjs', import.meta.url);
  const reloadPath = fixture.path('prepare-source-reload.mjs');
  await writeFile(reloadPath, (await readFile(reloadSource, 'utf8')).replace(/from '(\.[^']+)'/g, (_match, specifier) => {
    const url = specifier === '../../build/build_source_runtime.mjs' ? pathToFileURL(runtimePath)
      : specifier === '../../build/build_source_web_ui.mjs' ? pathToFileURL(publicOwner) : new URL(specifier, reloadSource);
    return `from ${JSON.stringify(url.href)}`;
  }));
  const { prepareSourceRuntimeReload } = await import(pathToFileURL(reloadPath));
  const reload = () => prepareSourceRuntimeReload({ stackName: 'independent', stackBaseDir: otherStackBaseDir,
    repoDir, args: ['--no-daemon', '--ui=export'], onHost: true,
    env: { ...env, HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_DB_PROVIDER: 'sqlite' } });
  const firstReload = await reload();
  const selectedServerPath = join(otherStackBaseDir, 'source-runtime/selected-server.json');
  const firstServer = await readFile(selectedServerPath, 'utf8');
  const firstReloadExports = await exports();
  const secondReload = await reload();
  assert.equal(secondReload.ui.uiDir, firstReload.ui.uiDir, 'two successful blue-green reloads share completed web bytes');
  assert.equal(await readFile(selectedServerPath, 'utf8'), firstServer, 'two successful blue-green reloads share completed runtime bytes');
  assert.equal(await exports(), firstReloadExports, 'the composed warm reload must skip the Expo producer');
  context.diagnostic('composed source reload passed twice with real shared server/web builders, scratch health and browser boot');
});

test('real Metro router transforms partition captures and reuse a stable project root', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-router-transform-cache-' });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const requireFromUi = createRequire(join(sourceRepo, 'apps/ui/package.json'));
  const Transformer = requireFromUi('metro/private/DeltaBundler/Transformer').default;
  const { FileStore } = requireFromUi('metro-cache');
  const routerContextFile = requireFromUi.resolve('expo-router/_ctx.web.js');
  const captures = [];
  for (const name of ['capture-a', 'capture-b']) {
    captures.push(await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: fixture.path(name) }));
  }
  assert.equal(relative(captures[0].uiProjectDir, routerContextFile),
    relative(captures[1].uiProjectDir, routerContextFile), 'the same installed module must have a colliding relative path');

  // Observe the filesystem boundary without substituting Metro, Babel, Router,
  // or cache logic. Await actual writes: Metro persists them asynchronously.
  class ObservedFileStore extends FileStore {
    reads = [];
    writes = [];
    async get(key) {
      const value = await super.get(key);
      this.reads.push(value !== null);
      return value;
    }
    set(key, value) {
      const pending = super.set(key, value);
      this.writes.push(pending);
      return pending;
    }
  }
  async function transform(capture, dev) {
    const requireFromCapture = createRequire(join(capture.uiProjectDir, 'package.json'));
    assert.equal(requireFromCapture.resolve('expo-router/_ctx.web.js'), routerContextFile);
    const configPath = requireFromCapture.resolve('./metro.config.js');
    delete requireFromCapture.cache[configPath];
    const config = requireFromCapture(configPath);
    assert.equal(config.projectRoot, capture.uiProjectDir);
    const store = new ObservedFileStore({ root: fixture.path('transforms') });
    config.cacheStores = [store];
    config.maxWorkers = 1;
    const transformer = new Transformer(config, { getOrComputeSha1: async file => {
      const content = await readFile(file);
      return { sha1: createHash('sha1').update(content).digest('hex'), content };
    } });
    const started = performance.now();
    try {
      const result = await transformer.transformFile(routerContextFile, {
        customTransformOptions: { routerRoot: './sources/app' }, dev,
        experimentalImportSupport: false, inlinePlatform: true, inlineRequires: false,
        minify: false, nonInlinedRequires: [], platform: 'web', type: 'module',
        unstable_transformProfile: 'default',
      });
      const elapsedMs = performance.now() - started;
      await Promise.all(store.writes);
      const dependency = result.dependencies.find(({ data }) => data.contextParams);
      assert.ok(dependency, 'the real Router transform must produce a require.context dependency');
      const routeRoot = resolve(dirname(routerContextFile), dependency.name);
      await access(join(routeRoot, '_layout.tsx'));
      return { routeRoot, key: result.unstable_transformResultKey, hits: store.reads, elapsedMs };
    } finally {
      await Promise.all(store.writes);
      await transformer.end();
    }
  }
  for (const dev of [false, true]) {
    const a = await transform(captures[0], dev);
    const b = await transform(captures[1], dev);
    // A new Transformer/config models reopening Metro at the same root.
    const repeat = await transform(captures[1], dev);
    context.diagnostic(JSON.stringify({ dev, coldAMs: a.elapsedMs, coldBMs: b.elapsedMs,
      warmBMs: repeat.elapsedMs, hits: [a.hits, b.hits, repeat.hits] }));
    assert.equal(a.routeRoot, join(captures[0].uiProjectDir, 'sources/app'));
    assert.equal(b.routeRoot, join(captures[1].uiProjectDir, 'sources/app'),
      'capture B must resolve its own route tree after capture A warms the shared cache');
    assert.equal(repeat.routeRoot, b.routeRoot);
    assert.notEqual(a.key, b.key);
    assert.equal(b.key, repeat.key);
    assert.deepEqual(a.hits, [false]);
    assert.deepEqual(b.hits, [false]);
    assert.deepEqual(repeat.hits, [true], 'a stable project root must reuse its persisted transform cache');
  }
});

test('shared source publication retains serving, selected and pending web exports independently', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-product-retention-', registerCleanup: false });
  const store = fixture.path('alias-stacks');
  await mkdir(fixture.path('stacks'));
  await symlink(fixture.path('stacks'), store, process.platform === 'win32' ? 'junction' : 'dir');
  const stackBaseDir = join(store, 'serving');
  const pending = await beginPendingSourceStart({ stackBaseDir: join(store, 'preparing') });
  t.after(async () => { await pending.dispose(); await setBundleReadOnly(fixture.root, false); await fixture.cleanup(); });
  const publish = async name => {
    const outputDir = join(store, 'source-bundles', `web-${name}`);
    const uiDir = join(outputDir, 'web');
    await mkdir(uiDir, { recursive: true });
    await writeFile(join(uiDir, 'index.html'), '<p>completed export</p>');
    await withSourceBundlePublication({ stackBaseDir, outputDir, record: { component: 'web', uiDir } }, async () => {});
    return { outputDir, uiDir };
  };
  const serving = await publish('serving');
  const servingLink = join(stackBaseDir, 'source-runtime/ui');
  await mkdir(dirname(servingLink), { recursive: true });
  await symlink(serving.uiDir, servingLink, process.platform === 'win32' ? 'junction' : 'dir');
  await recordStackRuntimeStart(join(stackBaseDir, 'stack.runtime.json'), {
    stackName: 'serving', ownerPid: process.pid, runtimeMode: 'source-snapshot', sourceUi: 'export',
    sourceUiLaunch: { uiDir: servingLink },
  });
  const preparationDir = join(store, 'preparing/source-runtime/bundle-reload');
  await mkdir(preparationDir);
  await writeFile(join(preparationDir, 'candidate.mjs'), 'export const ready = true;');
  await pending.retainPreparation(preparationDir);
  const preparing = await publish('preparing');
  await pending.retainPreparation(preparing.outputDir);
  const selected = await publish('selected');
  await mkdir(join(stackBaseDir, 'source-runtime'), { recursive: true });
  await writeFile(join(stackBaseDir, 'source-runtime/selected-ui.json'), JSON.stringify({ uiDir: selected.uiDir }));
  const abandoned = await publish('abandoned');
  await publish('newest');
  for (const product of [serving, preparing, selected]) await access(join(product.uiDir, 'index.html'));
  await access(join(preparationDir, 'candidate.mjs'));
  if (process.platform !== 'win32') await assert.rejects(access(abandoned.uiDir), { code: 'ENOENT' });
  await pending.publish(async () => {});
  await publish('after-preparation');
  await access(join(serving.uiDir, 'index.html'));
  await access(join(selected.uiDir, 'index.html'));
  if (process.platform !== 'win32') {
    await assert.rejects(access(preparing.uiDir), { code: 'ENOENT' });
    await assert.rejects(access(preparationDir), { code: 'ENOENT' });
  }
});

test('failed source product publication retires completion before a competing reader can adopt it', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-web-completion-handoff-', registerCleanup: false });
  const stackBaseDir = fixture.path('stacks/consumer');
  const pending = await beginPendingSourceStart({ stackBaseDir });
  let replacement;
  t.after(async () => {
    await replacement?.dispose();
    await pending.dispose();
    await setBundleReadOnly(fixture.root, false);
    await fixture.cleanup();
  });
  const outputDir = fixture.path('stacks/source-bundles/bundle-failed');
  await mkdir(join(outputDir, 'web'), { recursive: true });
  await writeFile(join(outputDir, 'web/index.html'), '<p>complete</p>');
  let entered;
  let release;
  const ready = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const failed = withSourceBundlePublication({ stackBaseDir, outputDir,
    record: { component: 'web', uiDir: join(outputDir, 'web') } }, async () => {
    entered();
    await resume;
    await pending.retainPreparation(outputDir);
  });
  const rejected = assert.rejects(failed, { code: 'ESOURCESTARTSUPERSEDED' });
  await ready;
  replacement = await beginPendingSourceStart({ stackBaseDir });
  const nextReader = withSourceBundlePublication({ stackBaseDir }, async () =>
    await assert.rejects(access(join(outputDir, 'source-bundle.json')), { code: 'ENOENT' }));
  release();
  await rejected;
  await nextReader;
});

test('cold Expo source preparation needs no workspace dist build or materialization stamp', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-expo-source-inputs-' });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('source');
  const owners = [...(await readWorkspacePackages(sourceRepo)).values()]
    .filter(({ root }) => relative(sourceRepo, root).startsWith('packages')
      || ['apps/ui', 'apps/stack'].includes(relative(sourceRepo, root).replaceAll('\\', '/')));
  await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: repoDir });
  await cp(join(sourceRepo, 'apps/stack/bin'), join(repoDir, 'apps/stack/bin'), { recursive: true });
  for (const { root } of owners) {
    const path = join(repoDir, relative(sourceRepo, root), 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.scripts = { ...manifest.scripts, build: 'node -e "throw new Error(\'workspace dist is not a Metro input\')"' };
    await writeFile(path, JSON.stringify(manifest));
  }
  const sharedInventory = join(repoDir, 'apps/ui/sources/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts.js');
  await writeFile(sharedInventory, '// another consumer owns this inventory\n');
  const env = { ...process.env, HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: fixture.path('consumer-a/inventory.js') };
  const result = await withExpoPreparationEnv(env, async preparationEnv => {
    const result = await ensureExpoWorkspacePrepared({ projectDir: join(repoDir, 'apps/ui'), env: preparationEnv });
    assert.equal(preparationEnv.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, result.outputPath);
    return result;
  });
  const inventory = await readFile(result.outputPath, 'utf8');
  assert.equal(result.outputPath, env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY);
  assert.equal(await readFile(sharedInventory, 'utf8'), '// another consumer owns this inventory\n');
  assert.match(inventory, /happier\.channels/);
  assert.match(inventory, /happier\.triage/);
  for (const [, assetPath] of inventory.matchAll(/require\(("(?:[^"\\]|\\.)*")\)/g)) await access(JSON.parse(assetPath));
  const other = await ensureExpoWorkspacePrepared({ projectDir: join(repoDir, 'apps/ui'),
    env: { ...env, HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: fixture.path('consumer-b/inventory.js') } });
  assert.notEqual(other.outputPath, result.outputPath);
  assert.equal(await readFile(result.outputPath, 'utf8'), inventory);
  for (const [, assetPath] of inventory.matchAll(/require\(("(?:[^"\\]|\\.)*")\)/g)) await access(JSON.parse(assetPath));
  assert.equal(await hasUsableExpoWorkspaceLastGreen({ projectDir: join(repoDir, 'apps/ui'), env }), true);
  const asset = inventory.match(/require\(("(?:[^"\\]|\\.)*")\)/);
  assert.ok(asset);
  await rm(JSON.parse(asset[1]));
  assert.equal(await hasUsableExpoWorkspaceLastGreen({ projectDir: join(repoDir, 'apps/ui'), env }), false,
    'real source inventory admission includes its published assets');
  await assert.rejects(access(join(repoDir, 'packages/plugin-sdk/dist')), { code: 'ENOENT' });
  await assert.rejects(access(join(repoDir, '.project/tmp/cli-source-dev-shared-deps-sync.json')), { code: 'ENOENT' });
});

async function prepareFiniteSourceWebFixture({ sourceRepo, repoDir }) {
  await captureSourceWebBuildInputs({ repoDir: sourceRepo, outputDir: repoDir });
  // Keep the real captured compiler/tooling, but author one small app/plugin.
  // The separate whole-app export case exercises the complete plugin census.
  const pluginName = '@happier-dev/plugins-admission-fixture';
  await writeFile(join(repoDir, 'apps/cli/package.json'), JSON.stringify({ name: '@happier-dev/cli',
    type: 'module', bundledDependencies: [pluginName] }));
  await writeFile(join(repoDir, 'apps/ui/package.json'), JSON.stringify({ name: '@happier-dev/ui',
    type: 'module', dependencies: { [pluginName]: '0.0.0' } }));
  await rm(join(repoDir, 'apps/ui/sources'), { recursive: true });
  await mkdir(join(repoDir, 'apps/ui/sources/app'), { recursive: true });
  const uiInput = join(repoDir, 'apps/ui/sources/app/_layout.tsx');
  const uiSource = 'export const admissionInput = "captured-ui-input";';
  await writeFile(uiInput, uiSource);
  const pluginRoot = join(repoDir, 'packages/plugins/admission-fixture');
  await mkdir(join(pluginRoot, 'src'), { recursive: true });
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: pluginName, version: '0.0.0',
    type: 'module', exports: { './manifest': './src/manifest.ts', './happier-plugin-ui/panel': './src/panel.ts' } }));
  await writeFile(join(pluginRoot, 'src/manifest.ts'), `export const PLUGIN_MANIFEST = ${JSON.stringify({
    id: 'happier.admission-fixture', contributes: { ui: {
      renderers: [{ id: 'panel', kind: 'reactNative', artifact: 'panel' }],
    } },
  })};`);
  const pluginInput = join(pluginRoot, 'src/panel.ts');
  await writeFile(pluginInput, 'export function renderSurface() { return "captured-plugin-input"; }');
  const toolInput = 'apps/ui/scripts/prepareSourcePluginUiArtifacts.mjs';
  const toolDigest = createHash('sha256').update(await readFile(join(repoDir, toolInput))).digest('hex');
  return { uiInput, uiSource, pluginInput, toolInput, toolDigest };
}

test('source web export retains captured UI and workspace inputs across live additions, removals and edits', async context => {
  const fixture = await createTempFixture(context, { prefix: 'happier-web-input-churn-' });
  const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
  const repoDir = fixture.path('live');
  const { toolInput, toolDigest } = await prepareFiniteSourceWebFixture({ sourceRepo, repoDir });
  const uiInput = 'apps/ui/sources/webExportChurn.ts';
  const workspaceInput = 'packages/protocol/src/webExportChurn.ts';
  const specimenInput = 'apps/ui/sources/dev/testkit/harness/liveExportSpecimen.ts';
  await mkdir(join(repoDir, 'apps/ui/sources/dev/testkit/harness'), { recursive: true });
  await writeFile(join(repoDir, specimenInput), 'export const specimen = "shipped-debug-fixture";');
  await writeFile(join(repoDir, uiInput), 'export const value = "captured-ui";');
  await writeFile(join(repoDir, workspaceInput), 'export const value = "captured-workspace";');
  const result = await exportSourceWebUi({ repoDir, baseDir: fixture.path('state'), outputDir: fixture.path('output'),
    env: { ...process.env, EXPO_PUBLIC_DEBUG: '0' },
    runImpl: async (_command, args, { cwd, env }) => {
      await rm(join(repoDir, uiInput));
      await writeFile(join(repoDir, workspaceInput), 'export const value = "changed-live";');
      await writeFile(join(repoDir, 'apps/ui/sources/createdDuringExport.ts'), 'export const late = true;');
      const inputRepo = join(cwd, '../..');
      assert.equal(await readFile(join(inputRepo, specimenInput), 'utf8'), 'export const specimen = "shipped-debug-fixture";');
      assert.equal(await readFile(join(inputRepo, uiInput), 'utf8'), 'export const value = "captured-ui";');
      assert.equal(await readFile(join(inputRepo, workspaceInput), 'utf8'), 'export const value = "captured-workspace";');
      await assert.rejects(access(join(cwd, 'sources/createdDuringExport.ts')), { code: 'ENOENT' });
      assert.equal(createHash('sha256').update(await readFile(join(inputRepo, toolInput))).digest('hex'), toolDigest);
      const inventory = (await readFile(env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8')).replaceAll('export const ', 'const ');
      const artifacts = runInNewContext(`${inventory}\nBUNDLED_PLUGIN_UI_APP_ARTIFACTS`, { require: path => path });
      assert.deepEqual(Array.from(artifacts, artifact => artifact.pluginId), ['happier.admission-fixture']);
      const module = { exports: {} };
      runInNewContext(await readFile(artifacts[0].files[0].asset, 'utf8'), { module, exports: module.exports });
      assert.equal(module.exports.renderSurface(), 'captured-plugin-input');
      const web = args[args.indexOf('--output-dir') + 1];
      await mkdir(web);
      await writeFile(join(web, 'index.html'), '<script src="./app.js"></script>');
      await writeFile(join(web, 'app.js'), 'globalThis.captured = true;');
    } });
  assert.equal(await readFile(join(result.uiDir, 'app.js'), 'utf8'), 'globalThis.captured = true;');
});

test('source web export uses fresh private source projections and one-shot origin-relative Expo output', async (context) => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-source-web-ui-'));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const baseDir = join(scratch, 'expo-state');
  const outputDir = join(scratch, 'export');
  let expectedOutputDir = outputDir;
  const exportInputs = [];
  const env = { ...process.env, EXPO_PUBLIC_HAPPIER_SERVER_URL: 'https://moving-producer.invalid', EXPO_PUBLIC_DEBUG: '0' };
  delete env.HAPPIER_STACK_EXPO_SHARED_TMPDIR_BASE_DIR;
  delete env.HAPPIER_STACK_EXPO_SHARED_TMPDIR_KEY;
  let exportCalls = 0;
  const residentEsbuildChildren = () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return [];
    return execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' })
      .split('\n').flatMap(line => {
        const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
        return row && Number(row[2]) === process.pid && !row[3].startsWith('Z')
          && /(?:^|[/\\])esbuild(?:\.exe)?$/.test(row[4]) ? [row[1]] : [];
      });
  };
  // Other tests use the compiler in this process. This finite preparation
  // owns only services it creates, not a preceding source tool's service.
  const existingEsbuildChildren = new Set(residentEsbuildChildren());
  // Expo is the external process boundary. Source preparation and its entire
  // first-party compiler/generator graph remain real beneath this boundary.
  const runImpl = async (command, args, options) => {
    if (args[0] !== 'export') return run(command, args, options);
    exportCalls += 1;
    await access(join(options.cwd, '../cli/scripts/buildPublication.mjs'));
    assert.equal(options.env.CI, '1');
    assert.equal(options.env.EXPO_PUBLIC_HAPPIER_SERVER_URL, '');
    assert.equal(options.env.EXPO_PUBLIC_DEBUG, exportCalls === 1 ? '0' : '1');
    assert.deepEqual(residentEsbuildChildren().filter(pid => !existingEsbuildChildren.has(pid)), [],
      'source preparation must release its esbuild service before Expo starts');
    const inventory = await readFile(options.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, 'utf8');
    assert.match(inventory, /happier\.channels/);
    assert.match(inventory, /happier\.posthog/);
    assert.match(inventory, /happier\.triage/);
    assert.match(inventory, /BUNDLED_PLUGIN_BRAND_MARKS/);
    assert.match(inventory, /happier\.inspector/);
    assert.match(inventory, /happier\.machine\.hetzner/);
    assert.ok(inventory.includes(expectedOutputDir));
    const uiDir = args[args.indexOf('--output-dir') + 1];
    exportInputs.push({ tmpDir: options.env.TMPDIR,
      inventoryPath: options.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY, uiDir });
    await mkdir(uiDir);
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><html><script src="./app.js"></script></html>');
    await writeFile(join(uiDir, 'app.js'), `globalThis.ready = ${exportCalls};\n`.repeat(300));
  };
  const result = await exportSourceWebUi({ repoDir, baseDir, outputDir, env, runImpl });
  assert.equal(exportCalls, 1);
  assert.equal(result.uiDir, join(outputDir, 'web'));
  assert.equal(result.entrypoint, 'index.html');
  await assert.rejects(access(join(result.uiDir, 'node_modules')), { code: 'ENOENT' });
  const firstBytes = await readFile(join(result.uiDir, 'app.js'), 'utf8');
  assert.equal(brotliDecompressSync(await readFile(join(result.uiDir, 'app.js.br'))).toString(), firstBytes);
  assert.equal(gunzipSync(await readFile(join(result.uiDir, 'app.js.gz'))).toString(), firstBytes);
  expectedOutputDir = join(scratch, 'second-export');
  delete env.EXPO_PUBLIC_DEBUG;
  const second = await exportSourceWebUi({ repoDir, baseDir, outputDir: expectedOutputDir, env, runImpl });
  assert.equal(exportCalls, 2);
  assert.equal(exportInputs[0].tmpDir, exportInputs[1].tmpDir,
    'explicit rebuilds must preserve the canonical Expo cache directory');
  assert.ok(exportInputs[0].tmpDir.startsWith(baseDir));
  assert.notEqual(exportInputs[0].inventoryPath, exportInputs[1].inventoryPath);
  assert.notEqual(result.uiDir, second.uiDir);
  assert.equal(await readFile(join(result.uiDir, 'app.js'), 'utf8'), firstBytes);
  assert.notEqual(await readFile(join(second.uiDir, 'app.js'), 'utf8'), firstBytes);
  const beforeReload = await readFile(join(result.uiDir, 'app.js'), 'utf8');
  const reloaded = await exportSourceWebUi({ repoDir, baseDir, outputDir: join(scratch, 'reload'),
    replaceUiDir: result.uiDir, env,
    runImpl: async (_command, args) => {
      assert.equal(await readFile(join(result.uiDir, 'app.js'), 'utf8'), beforeReload,
        'the live server must keep serving its previous export during preparation');
      const web = args[args.indexOf('--output-dir') + 1];
      await mkdir(web);
      await writeFile(join(web, 'index.html'), '<script src="./current.js"></script>');
      await writeFile(join(web, 'current.js'), 'globalThis.current = true;');
    } });
  assert.equal(reloaded.uiDir, result.uiDir, 'reload publishes at the existing server path without restarting it');
  assert.equal(await readFile(join(result.uiDir, 'current.js'), 'utf8'), 'globalThis.current = true;');
  await assert.rejects(access(join(result.uiDir, 'app.js')), { code: 'ENOENT' });
  await assert.rejects(exportSourceWebUi({ repoDir, baseDir, outputDir,
    replaceUiDir: result.uiDir, env }), { code: 'EEXIST' });
  assert.equal(await readFile(join(result.uiDir, 'current.js'), 'utf8'), 'globalThis.current = true;',
    'failed reload must retain the currently served export');
});

test('source web export admits its complete finite capture before consumption and reuses custody for Expo',
  { skip: process.platform !== 'linux', timeout: 180000 }, async (context) => {
    const fixture = await createTempFixture(context, { prefix: 'happier-source-expo-admission-', registerCleanup: false });
    let pending;
    context.after(async () => { await Promise.allSettled([pending]); await fixture.cleanup(); });
    const native = await installNativeAdmissionFixture({ root: fixture.root });
    const sourceRepo = fileURLToPath(new URL('../../../../', import.meta.url));
    const repoDir = fixture.path('repo');
    const { uiInput, uiSource, pluginInput, toolInput, toolDigest } = await prepareFiniteSourceWebFixture({ sourceRepo, repoDir });
    const outputDir = fixture.path('export');
    const available = fixture.path('available-memory');
    const lowMemoryObserved = fixture.path('low-memory-observed');
    const executed = fixture.path('expo-executed');
    await writeFile(available, '5242880');
    await mkdir(fixture.path('bin'));
    await writeFile(fixture.path('bin/awk'), `#!/bin/sh
case "$*" in
  */proc/meminfo*)
    available=$(/bin/cat '${available}')
    printf '%s 16777216\\n' "$available"
    [ "$available" -ne 5242880 ] || printf 'observed' > '${lowMemoryObserved}'
    ;;
  */proc/loadavg*|*/proc/pressure/*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
`);
    await chmod(fixture.path('bin/awk'), 0o755);
    const expo = fixture.path('bin/expo');
    const expoScript = fixture.path('expo.mjs');
    await writeFile(expo, `#!/bin/sh\nexec '${process.execPath}' '${expoScript}' "$@"\n`);
    await chmod(expo, 0o755);
    await writeFile(expoScript, `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
const root=${JSON.stringify(native.admissionRoot)};
const token=process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN;
const owner=token && join(root,'owners',token.replace(':','-'));
const capturedRepo=resolve(process.cwd(),'../..');
assert.equal(readFileSync(join(capturedRepo,'apps/ui/sources/app/_layout.tsx'),'utf8'),${JSON.stringify(uiSource)});
assert.equal(createHash('sha256').update(readFileSync(join(capturedRepo,${JSON.stringify(toolInput)}))).digest('hex'),${JSON.stringify(toolDigest)});
const inventory=readFileSync(process.env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY,'utf8').replaceAll('export const ','const ');
const artifacts=runInNewContext(inventory+'\\nBUNDLED_PLUGIN_UI_APP_ARTIFACTS',{require:path=>path});
assert.deepEqual(Array.from(artifacts,artifact=>artifact.pluginId),['happier.admission-fixture']);
const module={exports:{}};
runInNewContext(readFileSync(artifacts[0].files[0].asset,'utf8'),{module,exports:module.exports});
assert.equal(module.exports.renderSurface(),'captured-plugin-input');
writeFileSync(${JSON.stringify(executed)},JSON.stringify({className:owner ? readFileSync(join(owner,'class'),'utf8').trim() : null, owners:readdirSync(join(root,'owners')).length,cwd:process.cwd()}));
const output=process.argv[process.argv.indexOf('--output-dir')+1];
mkdirSync(output);writeFileSync(join(output,'index.html'),'<!doctype html><script src="./app.js"></script>');
writeFileSync(join(output,'app.js'),'globalThis.ready=true;');
`);
    const adapter = fixture.path('native-owner/apps/stack/scripts/utils/proc/runSourceBuildCommand.mjs');
    const adapterSource = new URL('../utils/proc/runSourceBuildCommand.mjs', import.meta.url);
    await writeFile(adapter, (await readFile(adapterSource, 'utf8')).replace(
      "from '../dev/devReloadCoordinator.mjs'", `from ${JSON.stringify(new URL('../dev/devReloadCoordinator.mjs', adapterSource).href)}`));
    const commandBoundary = fixture.path('expo-command.mjs');
    // Mock only installed executable lookup and physical OS memory. Public
    // orchestration, preparation, admission and the external process stay real.
    await writeFile(commandBoundary, `
export {prepareExpoCommandEnv,applyExpoExportMaxWorkersArgs} from ${JSON.stringify(new URL('../utils/expo/command.mjs', import.meta.url).href)};
import {writeFile} from 'node:fs/promises';
export async function resolveExpoBin() {
  await writeFile(${JSON.stringify(uiInput)},'export const admissionInput = "moving-ui-input";');
  await writeFile(${JSON.stringify(pluginInput)},'export function renderSurface() { return "moving-plugin-input"; }');
  return ${JSON.stringify(expo)};
}
`);
    const sourceUrl = new URL('./build_source_web_ui.mjs', import.meta.url);
    const publicOwner = fixture.path('public-source-web-ui.mjs');
    const source = (await readFile(sourceUrl, 'utf8')).replace(/from '(\.[^']+)'/g, (_match, specifier) => {
      const url = specifier === '../utils/proc/runSourceBuildCommand.mjs' ? pathToFileURL(adapter)
        : specifier === '../utils/expo/command.mjs' ? pathToFileURL(commandBoundary) : new URL(specifier, sourceUrl);
      return `from ${JSON.stringify(url.href)}`;
    });
    await writeFile(publicOwner, source);
    const { exportSourceWebUi: exportWithOsFixture } = await import(pathToFileURL(publicOwner));
    const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${fixture.path('bin')}:/usr/bin:/bin`, HAPPIER_DEV_TARGET_EXECUTION: '1' };
    await mkdir(join(native.admissionRoot, 'waiters'), { recursive: true });
    await mkdir(join(native.admissionRoot, 'owners'), { recursive: true });
    const watcher = watch(join(native.admissionRoot, 'waiters'));
    context.after(() => watcher.close());
    const pressureWatcher = watch(fixture.root);
    context.after(() => pressureWatcher.close());
    const observedPressure = new Promise((resolve, reject) => {
      pressureWatcher.on('error', reject);
      pressureWatcher.on('change', (_event, filename) => {
        if (filename === 'low-memory-observed') { pressureWatcher.close(); resolve(); }
      });
    });
    const queued = new Promise((resolve, reject) => {
      watcher.on('error', reject);
      watcher.on('change', async () => {
        try {
          if ((await readFile(available, 'utf8')) === '5242880'
            && (await readdir(join(native.admissionRoot, 'waiters'))).length) {
            watcher.close();
            resolve('queued');
          }
        } catch (error) { reject(error); }
      });
    });
    pending = exportWithOsFixture({ repoDir, baseDir: fixture.path('expo-state'), outputDir, env, signal: context.signal });
    void pending.catch(() => {});
    assert.equal(await Promise.race([queued, pending.then(() => 'finished')]), 'queued',
      'finite capture must wait for host memory before reading installed bytes');
    await observedPressure;
    await assert.rejects(access(executed), { code: 'ENOENT' });
    assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), [], 'no capacity is reserved while queued');
    await withDependencyRefreshLock({ installDir: repoDir, env, signal: context.signal }, async () => {});
    await writeFile(available, '16777216');
    await pending;
    assert.deepEqual(JSON.parse(await readFile(executed, 'utf8')),
      { className: 'validation', owners: 1, cwd: join(outputDir, 'workspace/apps/ui') });
    assert.deepEqual(await readdir(join(native.admissionRoot, 'owners')), []);
    assert.deepEqual(await readdir(join(native.admissionRoot, 'waiters')), []);
  });
