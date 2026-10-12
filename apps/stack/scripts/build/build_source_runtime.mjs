import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runSourceBuildCommand } from '../utils/proc/runSourceBuildCommand.mjs';
import { runWorkspaceBuildAdmission } from '../utils/proc/workspace_build_admission.mjs';
import { withWorkspaceBundleLock, isWorkspaceBundleLockActive } from '../../../../packages/cli-common/workspaceBundleLock.mjs';
import { isPidAlive } from '../utils/proc/pids.mjs';
import { readWorkspaceBuildInputs, resolveSourcePluginUiBuildInputPaths } from '../utils/fs/workspaceBuildInputs.mjs';
import { readCachedFileDigestSync } from '../utils/fs/cached_file_digest.mjs';
import { writeJsonAtomic } from '../utils/fs/json.mjs';
import { withJsonOwnerFileLock } from '../utils/proc/jsonOwnerFileLock.mjs';
import { run, runCapture } from '../utils/proc/proc.mjs';
import { isDevStartupSourceDrift, prepareSourceComponent } from '../utils/dev/devReloadCoordinator.mjs';
import { captureBuildInputFiles, mountCapturedWorkspaceDependencies } from '../../../../scripts/workspaces/buildInputConvergence.mjs';

import { SOURCE_CONDITION, sourceExport, readWorkspacePackages, resolveWorkspaceSource, workspaceSourceCompilerPaths, packageNameOfSpecifier, readCliSourceEntries, createWorkspaceSourceResolver, bundleCliSourceSidecars, runtimePackageExports } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';
export { readWorkspacePackages, resolveWorkspaceSource } from '../../../../packages/cli-common/sourceRuntimeEntries.mjs';

/** Finite web builds reuse workspace capture, not a second snapshot engine.
 * Capture authored inputs only; installed third-party tools retain their owner.
 * Later source edits belong to the next explicit build, never this Metro crawl. */
export async function captureSourceWebBuildInputs({ repoDir, outputDir, signal }) {
  repoDir = resolve(repoDir);
  const packages = await readWorkspacePackages(repoDir);
  const owners = [...packages.values()].filter(({ root }) => {
    const path = relative(repoDir, root).replaceAll('\\', '/');
    return path.startsWith('packages/') || path === 'apps/ui' || path === 'apps/stack';
  });
  const workspaceDirs = owners.map(({ root }) => relative(repoDir, root));
  signal?.throwIfAborted();
  const started = performance.now();
  const capture = await captureBuildInputFiles({ sourceDir: repoDir, captureDir: outputDir,
    readPaths: () => {
      signal?.throwIfAborted();
      const paths = [repoDir, ...owners.map(({ root }) => root)].flatMap(root =>
        readWorkspaceBuildInputs(root, {
          includeShippedFiles: root === join(repoDir, 'packages/plugin-sdk')
            || relative(repoDir, root).replaceAll('\\', '/').startsWith('packages/plugins/'),
          excludeGeneratedPluginArtifacts: relative(repoDir, root).replaceAll('\\', '/').startsWith('packages/plugins/'),
          additionalInputPaths: root === repoDir
            // Stack preparation imports the CLI publication policy, not its source tree.
            ? ['apps/cli/scripts/buildPublication.mjs']
            : root === join(repoDir, 'apps/ui')
              ? ['index.ts', 'public', 'plugins', 'modules', 'sources/dev/testkit'] : [],
        }).map(path => relative(repoDir, resolve(root, path))));
      // Layout discovery needs app manifests, not unrelated app source trees.
      for (const { root } of packages.values()) paths.push(relative(repoDir, join(root, 'package.json')));
      if (existsSync(join(repoDir, 'yarn.lock'))) paths.push('yarn.lock');
      return paths;
    } });
  await mountCapturedWorkspaceDependencies({ sourceDir: repoDir, captureDir: outputDir, workspaceDirs });
  signal?.throwIfAborted();
  console.log(`[source-ui] phase=input-capture elapsedMs=${Math.round(performance.now() - started)} files=${capture.files.length}`);
  return { repoDir: outputDir, uiProjectDir: join(outputDir, 'apps/ui') };
}

async function linkInstalledDirectory(from, to) {
  if (!existsSync(from)) return;
  await mkdir(dirname(to), { recursive: true });
  await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir');
}

async function sourceBundleFingerprint({ repoDir, component, serverComponent, dbProvider }) {
  const hash = createHash('sha256');
  const projectDir = join(repoDir, 'apps', component === 'daemon' ? 'cli' : 'server');
  const esbuild = createRequire(pathToFileURL(join(projectDir, 'package.json')))('esbuild');
  hash.update(JSON.stringify([repoDir, component, serverComponent, dbProvider, process.version, process.platform, process.arch, esbuild.version]));
  const inputs = new Set([fileURLToPath(import.meta.url), join(repoDir, 'yarn.lock'),
    join(repoDir, 'packages/cli-common/cliRuntimeSidecars.mjs'),
    join(repoDir, 'scripts/workspaces/buildTypeScriptPackageDist.mjs'),
    join(repoDir, 'scripts/workspaces/resolveTypeScriptCliInvocation.mjs')]);
  if (component === 'daemon') {
    for (const input of resolveSourcePluginUiBuildInputPaths(repoDir)) inputs.add(input);
  }
  for (const { root } of (await readWorkspacePackages(repoDir)).values()) {
    if (root !== projectDir && !relative(repoDir, root).startsWith(`packages`)) continue;
    for (const input of readWorkspaceBuildInputs(root)) inputs.add(join(root, input));
  }
  if (component === 'daemon') {
    for (const input of readWorkspaceBuildInputs(projectDir, { additionalInputPaths: ['native/processcustody'] })) inputs.add(join(projectDir, input));
  }
  // Prisma assets are copied inputs; retained checkout databases are never inputs.
  const visit = async directory => {
    if (!existsSync(directory)) return;
    for (const entry of await readdir(directory, {withFileTypes:true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (/\.(?:prisma|sql)$/.test(entry.name) || entry.name === 'migration_lock.toml') inputs.add(path);
    }
  };
  if (component === 'server') await visit(join(projectDir, 'prisma'));
  for (const path of [...inputs].sort()) {
    if (!existsSync(path)) continue;
    hash.update(relative(repoDir, path));
    hash.update(readCachedFileDigestSync(path, statSync(path, {bigint:true})));
  }
  return hash.digest('hex');
}

async function readReusableSourceBundle({ bundleRoot, repoDir, fingerprint }) {
  if (!existsSync(bundleRoot)) return null;
  for (const entry of await readdir(bundleRoot, {withFileTypes:true})) {
    if (!entry.isDirectory() || !entry.name.startsWith('bundle-')) continue;
    const outputDir = join(bundleRoot, entry.name);
    const record = await readOptionalJson(join(outputDir, 'source-bundle.json'));
    if (record?.reuseFingerprint !== fingerprint || !record.sourceInputDigests) continue;
    // A consumed file can change and be undone during preparation. The wide
    // membership fingerprint is only a cache hint; captured load bytes decide
    // whether this emitted graph is reusable for the current source.
    const current = Object.entries(record.sourceInputDigests).every(([path, digest]) => {
      const absolute = resolve(repoDir, path);
      return digest && existsSync(absolute)
        && readCachedFileDigestSync(absolute, statSync(absolute, {bigint:true})) === digest;
    });
    if (!current) continue;
    const {reuseFingerprint, sourceInputDigests, ...built} = record;
    return {outputDir, built};
  }
  return null;
}

function sourceBundleBuildLockPath(bundleRoot, fingerprint) {
  return join(bundleRoot, `build-${fingerprint}.lock`);
}

async function setBundleReadOnly(directory, readOnly) {
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue; // Installed dependencies keep their own lifecycle.
    if (entry.isDirectory()) {
      if (!readOnly) await chmod(path, 0o755);
      await setBundleReadOnly(path, readOnly);
    } else {
      const mode = (await lstat(path)).mode;
      await chmod(path, readOnly ? mode & ~0o222 : mode | 0o200);
    }
  }
  await chmod(directory, readOnly ? 0o555 : 0o755);
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function isFirstPartyBuiltInput(key, workspacePackages) {
  key = key.replaceAll('\\', '/');
  if (!/^(?:packages|apps)\//.test(key)) return false;
  // The innermost installed package owns its files. A third-party dist tree
  // below a workspace (or bundled workspace copy) is not first-party output.
  const installed = key.split('/node_modules/').at(-1);
  if (installed !== key && !workspacePackages.has(packageNameOfSpecifier(installed))
      && !installed.startsWith('@happier-dev/')) return false;
  return /(?:^|\/)(?:dist|package-dist|\.happier-plugin)\//.test(installed);
}

async function emitSourceAuthorPackages({ repoDir, projectDir, runtimeDir, workspacePackages, build,
  sourceInputDigests, readSourceInput }) {
  const workDir = await mkdtemp(join(runtimeDir, '.author-emission-'));
  try {
    const { withDistProjectCompilerArgs } = await import('../../../../scripts/workspaces/buildTypeScriptPackageDist.mjs');
    const { resolveTypeScriptCliInvocation, matchesNativeTypeScriptInputVersion } = await import('../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs');
    // Run the existing package classification, closure and physical copier
    // directly from source, not from a workspace dist prerequisite.
    const ownerPath = join(workDir, 'workspaces.mjs');
    await build({entryPoints:[fileURLToPath(new URL('../../../../packages/cli-common/src/workspaces/index.ts', import.meta.url))],
      outfile:ownerPath, bundle:true, platform:'node', format:'esm', logLevel:'silent'});
    const owner = await import(pathToFileURL(ownerPath).href);
    const bundles = owner.resolveWorkspaceBundlesFromPackageJson({repoRoot:repoDir,hostPackageDir:projectDir});
    const roots = bundles.filter(bundle => owner.sanitizeBundledPackageJson(
      workspacePackages.get(bundle.packageName).manifest).happier?.publicSdkRelease);
    const closure = new Set(owner.resolveInternalWorkspacePackageNameClosure({repoRoot:repoDir,
      packageNames:roots.map(bundle => bundle.packageName)}));
    const authorRoot = join(runtimeDir, 'authoring/node_modules');
    const codeFiles = [];
    const sourcePaths = workspaceSourceCompilerPaths(workspacePackages);
    for (const bundle of bundles) {
      const destDir = join(authorRoot, ...bundle.packageName.split('/'));
      await mkdir(destDir, {recursive:true});
      if (!closure.has(bundle.packageName)) {
        // The existing author materializer inventories all host bundle names,
        // but only public roots and their declared dependencies are copied.
        await writeFile(join(destDir, 'package.json'), JSON.stringify(workspacePackages.get(bundle.packageName).manifest));
        continue;
      }
      const compilerDir = join(workDir, ...bundle.packageName.split('/'));
      await mkdir(compilerDir, {recursive:true});
      const outputDir = join(compilerDir, 'emitted');
      const buildInfoPath = join(compilerDir, 'build.tsbuildinfo');
      const args = await withDistProjectCompilerArgs(['--outDir',outputDir,'--tsBuildInfoFile',buildInfoPath,
        '--incremental','--noCheck'], {projectPath:join(bundle.srcDir,'tsconfig.json'),workDir:compilerDir,
        compilerOptions:{rootDir:repoDir,customConditions:[SOURCE_CONDITION],paths:sourcePaths,declaration:true,
          noEmit:false,emitDeclarationOnly:false}});
      const invocation = resolveTypeScriptCliInvocation({args,workspaceDir:repoDir,admissionClass:'source-bundle'});
      await runCapture(invocation.command, [...invocation.argsPrefix,...args], {cwd:repoDir,ownedProcessGroup:true});
      const info = JSON.parse(await readFile(buildInfoPath, 'utf8'));
      for (const [index, file] of info.fileNames.entries()) {
        // Native TypeScript records its built-in libraries as bare logical
        // names, not paths relative to this caller-owned compiler directory.
        if (/^lib(?:\.[^/\\]+)?\.d\.ts$/.test(file)) continue;
        const path = realpathSync(resolve(compilerDir, file));
        // These are this build's dependency-first outputs, already traced to
        // consumed source bytes above. Checkout/installed dist stays forbidden.
        if (path.startsWith(realpathSync(authorRoot) + sep)) continue;
        const key = relative(realpathSync(repoDir), path).replaceAll('\\', '/');
        if (!/^(?:packages|apps)\//.test(key)) continue;
        if (isFirstPartyBuiltInput(key, workspacePackages)) {
          throw new Error(`Source author closure consumed first-party built code: ${key}`);
        }
        const contents = await readSourceInput(path);
        const version = typeof info.fileInfos[index] === 'string' ? info.fileInfos[index] : info.fileInfos[index].version;
        // The compiler's consumed input version is the authority. An editor
        // undo during emission cannot cache the graph under restored bytes.
        if (!await matchesNativeTypeScriptInputVersion(contents, version)) sourceInputDigests[relative(repoDir,path)] = null;
      }
      owner.bundleWorkspacePackageWithRuntimeDependencies({...bundle,destDir,
        distDir:join(outputDir, relative(repoDir,bundle.srcDir),'src')});
      // The closure is dependency-first. Later packages consume declarations
      // from this build's physical package, rather than re-inferring and
      // re-emitting every dependency's source graph. Never use checkout dist.
      for (const [specifier, targets] of Object.entries(sourcePaths)) {
        if (packageNameOfSpecifier(specifier) !== bundle.packageName) continue;
        sourcePaths[specifier] = targets.map(source => {
          if (!/\.(?:tsx?|mts|cts)$/.test(source)) return source;
          const declaration = relative(join(bundle.srcDir, 'src'), source)
            .replace(/\.(?:ts|tsx)$/, '.d.ts').replace(/\.mts$/, '.d.mts').replace(/\.cts$/, '.d.cts');
          return join(destDir, 'dist', declaration);
        });
      }
      const visit = async directory => {
        for (const entry of await readdir(directory, {withFileTypes:true})) {
          const path = join(directory,entry.name);
          if (entry.isDirectory()) await visit(path);
          else if (!entry.isSymbolicLink()) codeFiles.push(path);
        }
      };
      await visit(destDir);
    }
    return codeFiles;
  } finally {
    await rm(workDir, {recursive:true,force:true});
  }
}

async function retainSourceBundles({ stacksRoot, bundleRoot, newest }) {
  const references = [newest];
  const candidates = [];
  let newestBuilt;
  // Completion and selection share publication custody. Allocation names bind
  // unfinished graphs to existing fingerprint custody, so cancellation leaves
  // no new ledger and a later publication can reclaim an abandoned allocation.
  for (const entry of await readdir(bundleRoot, {withFileTypes:true})) {
    if (!entry.isDirectory() || !entry.name.startsWith('bundle-')) continue;
    const directory = join(bundleRoot, entry.name);
    const record = await readOptionalJson(join(directory, 'source-bundle.json'));
    if (!record) {
      const fingerprint = /^bundle-([a-f0-9]{64})-/.exec(entry.name)?.[1];
      // Old allocation names cannot prove unfinished-producer custody.
      if (!fingerprint || isWorkspaceBundleLockActive(sourceBundleBuildLockPath(bundleRoot, fingerprint), {staleAfterMs:Infinity})) continue;
      candidates.push(directory);
      continue;
    }
    const createdMs = (await lstat(directory)).mtimeMs;
    if (!newestBuilt || createdMs > newestBuilt.createdMs) newestBuilt = {directory, createdMs};
    if (record.reuseFingerprint && isWorkspaceBundleLockActive(sourceBundleBuildLockPath(bundleRoot, record.reuseFingerprint), {staleAfterMs:Infinity})) continue;
    candidates.push(directory);
  }
  if (newestBuilt) references.push(newestBuilt.directory);
  for (const entry of await readdir(stacksRoot, {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.name === 'source-bundles') continue;
    const stackBaseDir = join(stacksRoot, entry.name);
    const sourceRoot = join(stackBaseDir, 'source-runtime');
    for (const component of ['daemon', 'server']) {
      const selected = await readOptionalJson(join(sourceRoot, `selected-${component}.json`));
      if (selected?.entrypoint) references.push(selected.entrypoint);
    }
    const state = await readOptionalJson(join(stackBaseDir, 'stack.runtime.json'));
    if ([state?.ownerPid, state?.processes?.daemonPid, ...(state?.processes?.daemonPids ?? [])].some(isPidAlive)
        && state?.sourceRuntimeLaunch?.entrypoint) references.push(state.sourceRuntimeLaunch.entrypoint);
    if (existsSync(sourceRoot)) for (const bundle of await readdir(sourceRoot, {withFileTypes:true})) {
      if (bundle.isDirectory() && bundle.name.startsWith('bundle-')) candidates.push(join(sourceRoot, bundle.name));
    }
  }
  // A detached daemon may outlive its Stack owner and its recorded launch.
  // Observe the actual command before reclaiming its lazy-loadable JS tree.
  let liveCommands = '';
  try {
    if (process.platform === 'win32') return; // No authoritative process command observation here.
    if (process.platform === 'linux') {
      for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
        try {
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          const uids = /^Uid:[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]+(\d+)/m.exec(status);
          if (uids && !uids.slice(1).some(uid => Number(uid) === process.getuid())) continue;
          liveCommands += '\n' + await readFile(`/proc/${pid}/cmdline`, 'utf8');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } else liveCommands = await runCapture('ps', ['-ax', '-o', 'command=']);
  } catch (error) {
    console.error(`[source-bundle] retaining bundles: live process observation unavailable (${error.code ?? error.message})`);
    return;
  }
  for (const directory of candidates) {
    if (references.some(path => path === directory || path.startsWith(directory + '/'))
        || references.some(path => path.startsWith(directory + '\\'))
        || liveCommands.includes(directory + '/')) continue;
    await setBundleReadOnly(directory, false);
    await rm(directory, {recursive:true, force:true});
  }
}

async function readSelectedSourceRuntimeBundle({ stackBaseDir, component, required = true }) {
  const selected = await readOptionalJson(join(stackBaseDir, 'source-runtime', `selected-${component}.json`));
  if (!selected && !required) return null;
  const record = selected?.entrypoint
    ? await readOptionalJson(join(resolve(dirname(selected.entrypoint), '../../..'), 'source-bundle.json')) : null;
  if (!record?.identity || record.entrypoint !== selected?.entrypoint || !existsSync(record.entrypoint)) {
    throw new Error(`[source-bundle] selected source ${component} bundle is unavailable; explicitly restart the Stack to select current source`);
  }
  const { reuseFingerprint, sourceInputDigests, ...built } = record;
  return built;
}

async function publishSourceRuntimeBundle({stackBaseDir, bundleRoot, component, built, record, signal, reuseSelected}) {
  // This is short output-metadata custody, not a workspace producer lease:
  // nobody compiles, acquires build leases or waits for admission underneath
  // it. The existing JSON publication owner can therefore finish an admitted
  // graph without reversing native workspace/admission ordering.
  return await withJsonOwnerFileLock(async () => {
    const outputDir = resolve(built.runtimeDir, '../..');
    if (record) {
      await writeJsonAtomic(join(outputDir, 'source-bundle.json'), record);
      await setBundleReadOnly(outputDir, true);
    }
    const completed = await readOptionalJson(join(outputDir, 'source-bundle.json'));
    if (completed?.identity !== built.identity || completed?.entrypoint !== built.entrypoint || !existsSync(built.entrypoint)) {
      throw new Error('[source-bundle] cannot select an incomplete source runtime graph');
    }
    signal?.throwIfAborted();
    // The only selection writer, after completion/read-only success. A failed
    // construction, completion rename or selection rename preserves the prior
    // coherent selection; unfinished output remains protected until cleanup.
    // A CLI bootstrap may have started before startup selected its graph.
    // Recheck under publication custody so it cannot replace that selection.
    const selectedBundle = reuseSelected === 'if-available'
      ? await readSelectedSourceRuntimeBundle({ stackBaseDir, component, required: false }) : null;
    if (!selectedBundle) {
      await writeJsonAtomic(join(stackBaseDir, 'source-runtime', `selected-${component}.json`), {entrypoint:built.entrypoint});
    }
    try {
      await retainSourceBundles({stacksRoot:dirname(stackBaseDir), bundleRoot, newest:outputDir});
    } catch (error) {
      // Reclamation is maintenance after successful publication. Keep the
      // coherent selected graph, report the failure, and retry retention at
      // the next publication rather than deleting a successful launch.
      console.error(`[source-bundle] published graph retained; reclamation failed (${error.code ?? error.message})`);
    }
    return selectedBundle ?? built;
  }, {lockPath:join(bundleRoot, 'publication.lock'), timeoutMs:Infinity, staleAfterMs:Infinity, signal,
    errorLabel:'source-bundle publication lock'});
}

/** Build from the execution host's installed source. Stack consumers share one
 * read-only result when source/tool inputs still match; explicit outputDir is the finite
 * producer boundary used by source-bundle tests and probes.
 */
export async function buildSourceRuntimeBundle(options) {
  if (options.stackBaseDir && options.reuseSelected) {
    const stackBaseDir = resolve(options.stackBaseDir);
    // Recovery and CLI commands read the pinned graph without consulting
    // moving source inputs or reserving source-build capacity.
    const selectedBundle = await withJsonOwnerFileLock(() => readSelectedSourceRuntimeBundle({
      stackBaseDir, component: options.component, required: options.reuseSelected !== 'if-available',
    }), { lockPath: join(dirname(stackBaseDir), 'source-bundles/publication.lock'),
      timeoutMs: Infinity, staleAfterMs: Infinity, signal: options.signal, errorLabel: 'source-bundle publication lock' });
    if (selectedBundle) return selectedBundle;
  }
  if (!options.stackBaseDir) return await buildSourceRuntimeBundleOnce(options);
  return await prepareSourceComponent({ repoDir: resolve(options.repoDir), target: options.component,
    env: options.env, signal: options.signal, logger: options.logger,
    prepare: () => buildSourceRuntimeBundleOnce(options) });
}

async function buildSourceRuntimeBundleOnce({ repoDir, outputDir, stackBaseDir, component, reuseSelected = false, serverComponent = 'happier-server-light', dbProvider,
  env = process.env, signal }) {
  repoDir = resolve(repoDir);
  if (stackBaseDir) {
    stackBaseDir = resolve(stackBaseDir);
    const bundleRoot = join(dirname(stackBaseDir), 'source-bundles');
    const inputs = {repoDir, component, serverComponent, dbProvider, reuseSelected};
    const fingerprint = await sourceBundleFingerprint(inputs);
    const lockPath = sourceBundleBuildLockPath(bundleRoot, fingerprint);
    // Reuse takes only short publication custody, never compiler admission.
    // The fingerprint lease prevents reading a graph before its builder has
    // completed read-only publication. Release both before a cold admission.
    const cached = await withWorkspaceBundleLock(async () => {
      const reusable = await readReusableSourceBundle({bundleRoot, repoDir, fingerprint});
      return reusable ? await publishSourceRuntimeBundle({stackBaseDir, bundleRoot, component, built:reusable.built, signal, reuseSelected}) : null;
    }, {lockPath, timeoutMs:Infinity, env, signal, errorLabel:'source-bundle build lock'});
    if (cached) return cached;
    // Only a cold fingerprint enters compiler admission. Its canonical lease
    // coalesces identical producers; the native owner releases it before
    // waiting on a busy host. Different fingerprints have independent outputs.
    const prepare = () => runWorkspaceBuildAdmission({ repoDir,
      launcherPath:fileURLToPath(new URL('../../bin/hstack-exec', import.meta.url)),
      command:process.execPath, args:[fileURLToPath(import.meta.url), JSON.stringify({...inputs, stackBaseDir, fingerprint})],
      locks:[{path:lockPath, kind:'workspace', timeoutMs:null, errorLabel:'source-bundle build lock'}],
      cwd:repoDir, env, signal, admissionClass:'source-bundle', stdio:['ignore','pipe','pipe'],
      onStderr:chunk => process.stderr.write(chunk) });
    let result = await prepare();
    if (!result.error && !result.signal && result.status === 1
        && /^HSTACK_WORKSPACE_ADMISSION_ORDER:/m.test(result.stderr)) {
      // A queued launcher can outlive an admission-protocol cutover. Its child
      // must not adopt the newer envelope underneath the inherited lease.
      // The terminal attempt has now unwound that lease: follow the admission
      // owner's instruction by invoking the complete joint producer afresh.
      signal?.throwIfAborted();
      process.stderr.write('[source-bundle] re-invoking joint workspace admission after the prior preparation lease was released\n');
      result = await prepare();
    }
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error(`Source preparation failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`})`);
      error.code = result.status;
      error.signal = result.signal;
      error.sourceDrift = isDevStartupSourceDrift({code:result.status, message:result.stderr}, component);
      throw error;
    }
    const built = JSON.parse(result.stdout);
    if (built.sourceInputsChanged) return await buildSourceRuntimeBundleOnce({ ...inputs, stackBaseDir, env, signal });
    // The finite producer completed publication before releasing fingerprint
    // custody. No unselected completed graph crosses an unprotected handoff.
    return built;
  }
  outputDir = resolve(outputDir);
  const stdout = await runSourceBuildCommand({ repoDir, scriptPath: fileURLToPath(import.meta.url),
    args: [JSON.stringify({ repoDir, outputDir, component, serverComponent, dbProvider })], env, signal, admissionClass:'source-bundle' });
  const {sourceInputDigests, ...built} = JSON.parse(stdout);
  await writeJsonAtomic(join(outputDir, 'source-bundle.json'), {...built, sourceInputDigests});
  return built;
}

async function prepareSharedSourceRuntimeBundle({repoDir, stackBaseDir, component, serverComponent, dbProvider, reuseSelected, fingerprint:admittedFingerprint,
  env = process.env, signal}) {
  const stacksRoot = dirname(stackBaseDir);
  const bundleRoot = join(stacksRoot, 'source-bundles');
  const inputs = {repoDir, component, serverComponent, dbProvider, reuseSelected};
  const fingerprint = await sourceBundleFingerprint(inputs);
  // An already-parsed, queued launcher from before this lock contraction has
  // no fingerprint in its payload. It still uses this canonical producer;
  // current launchers additionally reselect if their queued inputs changed.
  if (admittedFingerprint && admittedFingerprint !== fingerprint) return {sourceInputsChanged:true};
  const reusable = await readReusableSourceBundle({bundleRoot, repoDir, fingerprint});
  let built = reusable?.built;
  let outputDir = reusable?.outputDir;
  if (!built) {
    await mkdir(bundleRoot, {recursive:true});
    // This allocation is not a claim about checkout bytes. The existing
    // emitted-code identity below describes what this finite build produced.
    outputDir = await mkdtemp(join(bundleRoot, `bundle-${fingerprint}-`));
    try {
      // This worker already owns fingerprint custody and compiler admission.
      // There is no second launch/admission for the same finite graph.
      const {sourceInputDigests, ...runtime} = await buildSourceRuntimeBundleInProcess({...inputs, outputDir});
      built = runtime;
      const unchanged = fingerprint === await sourceBundleFingerprint(inputs);
      signal?.throwIfAborted();
      return await publishSourceRuntimeBundle({stackBaseDir, bundleRoot, component, built, signal, reuseSelected,
        record:{...built, sourceInputDigests, reuseFingerprint:unchanged ? fingerprint : null}});
    } catch (error) {
      if (existsSync(outputDir)) { await setBundleReadOnly(outputDir, false); await rm(outputDir, {recursive:true, force:true}); }
      throw error;
    }
  }
  signal?.throwIfAborted();
  return await publishSourceRuntimeBundle({stackBaseDir, bundleRoot, component, built, signal, reuseSelected});
}

async function buildSourceRuntimeBundleInProcess({ repoDir, outputDir, component, serverComponent, dbProvider }) {
  if (component !== 'daemon' && component !== 'server') throw new Error(`Unsupported source runtime component: ${component}`);
  repoDir = resolve(repoDir);
  outputDir = resolve(outputDir);
  await mkdir(outputDir, { recursive: true });
  if ((await readdir(outputDir)).length > 0) throw new Error(`Source runtime output directory must be empty: ${outputDir}`);
  const projectDir = join(repoDir, 'apps', component === 'daemon' ? 'cli' : 'server');
  const runtimeDir = join(outputDir, 'apps', component === 'daemon' ? 'cli' : 'server');
  await mkdir(runtimeDir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'));
  const requireFromProject = createRequire(pathToFileURL(join(projectDir, 'package.json')));
  const esbuild = requireFromProject('esbuild');
  // Each admitted worker owns exactly one build. Retire its native service
  // before returning the result to the long-lived caller.
  const interrupt = () => { esbuild.stop(); process.exit(130); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    return await emitSourceRuntimeBundle({ repoDir, outputDir, component, serverComponent, dbProvider,
      projectDir, runtimeDir, manifest, requireFromProject, esbuild });
  } finally {
    esbuild.stop();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

// Private finite worker: callers use the public function above so every source
// build goes through the existing host admission owner before graph construction.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = JSON.parse(process.argv[2]);
    let result;
    if (options.stackBaseDir) {
      // Preserve cancellation during fingerprint observation/publication;
      // graph construction also retires its own native esbuild service.
      const cancellation = new AbortController();
      const interrupt = () => cancellation.abort();
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      try {
        result = await prepareSharedSourceRuntimeBundle({...options, signal:cancellation.signal});
      } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      }
    } else result = await buildSourceRuntimeBundleInProcess(options);
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    if (error?.name === 'AbortError') process.exitCode = 130;
    else {
      console.error(error);
      process.exitCode = 1;
    }
  }
}

async function emitSourceRuntimeBundle({ repoDir, outputDir, component, serverComponent, dbProvider,
  projectDir, runtimeDir, manifest, requireFromProject, esbuild }) {
  const { transform } = esbuild;
  const sourceInputDigests = {};
  const readSourceInput = async path => {
    const contents = await readFile(path);
    const key = relative(repoDir, path);
    const digest = createHash('sha256').update(contents).digest('hex');
    const previous = sourceInputDigests[key];
    sourceInputDigests[key] = previous === undefined || previous === digest ? digest : null;
    return contents;
  };
  const captureInputs = {name:'source-runtime-consumed-inputs', setup(builder) {
    builder.onLoad({filter:/.*/, namespace:'file'}, async ({path}) => ({
      contents:await readSourceInput(path), loader:'default', resolveDir:dirname(path),
    }));
  }};
  // Capture the bytes actually returned to esbuild, including sidecar graphs.
  // Its metafile inventories paths/byte counts, not the consumed content digest.
  const build = options => esbuild.build({...options, plugins:[...(options.plugins ?? []), captureInputs]});
  const workspacePackages = await readWorkspacePackages(repoDir);
  const entries = {};
  let migrationSource;
  let sqliteMigration = false;
  const pluginMetadata = [];
  const outputPrefix = component === 'daemon' ? 'apps/cli' : 'apps/server';
  if (component === 'daemon') {
    const cli = await readCliSourceEntries({repoDir, manifest, transform});
    Object.assign(entries, cli.entries);
    pluginMetadata.push(...cli.pluginMetadata.map(item => ({...item, dir:join(outputDir,item.prefix)})));
  } else {
    if (serverComponent !== 'happier-server-light' && serverComponent !== 'happier-server') throw new Error(`Unsupported server component: ${serverComponent}`);
    entries[`${outputPrefix}/sources/main`] = join(projectDir, 'sources', serverComponent === 'happier-server-light' ? 'main.light.ts' : 'main.ts');
    const provider = dbProvider ?? (serverComponent === 'happier-server-light' ? 'sqlite' : 'postgres');
    const migrationScript = { postgres: 'full', mysql: 'mysql', pglite: 'light' }[provider];
    if (migrationScript) {
      migrationSource = join(projectDir, 'scripts', `migrate.${migrationScript}.deploy.ts`);
      entries[`${outputPrefix}/scripts/migrate`] = migrationSource;
    } else if (provider === 'sqlite') {
      sqliteMigration = true;
      entries[`${outputPrefix}/scripts/migrate`] = 'source-runtime:sqlite-migration';
    } else if (provider !== 'sqlite') throw new Error(`Unsupported source database provider: ${provider}`);
  }
  const plugin = {
    name: 'source-runtime-boundaries',
    setup(builder) {
      if (sqliteMigration) {
        builder.onResolve({ filter: /^source-runtime:sqlite-migration$/ }, () => ({ path: 'sqlite-migration', namespace: 'source-runtime' }));
        builder.onLoad({ filter: /.*/, namespace: 'source-runtime' }, () => ({
          contents: `import {runSqliteMigrationDeploy} from ${JSON.stringify(join(projectDir, 'scripts/migrate.sqlite.deploy.ts'))};\nawait runSqliteMigrationDeploy({serverRoot:${JSON.stringify(runtimeDir)},runSchemaSync:async()=>{}});\n`,
          loader: 'js', resolveDir: projectDir,
        }));
      }
      if (migrationSource) builder.onLoad({ filter: /migrate\.(?:full|mysql|light)\.deploy\.ts$/ }, async (args) => {
        if (args.path !== migrationSource) return;
        return {
          contents: (await readSourceInput(args.path)).toString('utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(join(runtimeDir, 'scripts/migrate.mjs')).href)),
          loader: 'ts', resolveDir: dirname(args.path),
        };
      });
      builder.onResolve({ filter: /generated\/(?:sqlite|mysql)-client/ }, (args) => ({ path: resolve(args.resolveDir, args.path), external: true }));
      // Native support has an existing deterministic package-root locator. Keep
      // that support root on the execution host; freeze all of its JS logic.
      builder.onLoad({ filter: /iroh-native[\\/]src[\\/]nodeNative\.ts$/ }, async (args) => ({
        contents: (await readSourceInput(args.path)).toString('utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href)),
        loader: 'ts', resolveDir: dirname(args.path),
      }));
    },
  };
  const result = await build({
    absWorkingDir: repoDir, entryPoints: entries, outdir: outputDir,
    bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node20',
    conditions: [SOURCE_CONDITION], tsconfig: join(projectDir, 'tsconfig.json'),
    chunkNames: `${outputPrefix}/src/chunks/[name]-[hash]`,
    banner: { js: "import { createRequire as __sourceCreateRequire } from 'node:module'; import {fileURLToPath as __sourceFileURLToPath} from 'node:url'; import {dirname as __sourcePathDirname} from 'node:path'; const require = __sourceCreateRequire(import.meta.url); const __sourceFilename = __sourceFileURLToPath(import.meta.url); const __sourceDirname = __sourcePathDirname(__sourceFilename);" },
    define: { __dirname: '__sourceDirname', __filename: '__sourceFilename' },
    metafile: true, logLevel: 'silent', plugins: [plugin, createWorkspaceSourceResolver({workspacePackages, requireFromProject})],
  });
  const runtimeManifest = component === 'daemon' ? {
    ...manifest, type: 'module', main: './src/index.mjs', module: './src/index.mjs',
    exports: Object.fromEntries(Object.keys(manifest.exports ?? {}).map((key) => [
      key, `./package-dist/${key === '.' ? 'index' : key.slice(2)}.mjs`,
    ])),
    imports: Object.fromEntries(Object.entries(manifest.imports ?? {}).map(([key, value]) => [
      key, `./package-dist/${sourceExport(value, key).slice('./src/'.length).replace(/\.[^.]+$/, '')}.mjs`,
    ])),
  } : { ...manifest, type: 'module' };
  await writeFile(join(runtimeDir, 'package.json'), JSON.stringify(runtimeManifest));
  for (const item of pluginMetadata) {
    await mkdir(join(item.dir, '.happier-plugin'), { recursive: true });
    await writeFile(join(item.dir, 'package.json'), JSON.stringify({...item.package,exports:runtimePackageExports(item.package.exports)}));
    await writeFile(join(item.dir, '.happier-plugin/plugin.json'), JSON.stringify(item.manifest));
  }
  const retainedCodeFiles = Object.keys(result.metafile.outputs).map((file) => resolve(repoDir, file));
  if (pluginMetadata.some(item => item.manifest.contributes !== undefined)) {
    const preparationDir = await mkdtemp(join(runtimeDir, '.source-plugin-ui-'));
    try {
      // The same source compiler used by native CLI construction owns these
      // graphs. Checkout dist can be republished while this daemon is serving.
      await run(process.execPath, ['--conditions=happier-source', '--import',
        fileURLToPath(new URL('../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url)),
        fileURLToPath(new URL('../../../ui/scripts/prepareSourcePluginUiArtifacts.mjs', import.meta.url))], {
        cwd: repoDir, stdio: ['ignore', 'ignore', 'inherit'], captureFailureDiagnostic: true,
        input: JSON.stringify({
          repoRoot: repoDir, outputDir: preparationDir,
          plugins: pluginMetadata.map(item => ({
            directory: item.package.name.slice('@happier-dev/plugins-'.length), manifest: item.manifest,
          })),
          artifactOutputDirs: Object.fromEntries(pluginMetadata.map(item => [
            item.package.name.slice('@happier-dev/plugins-'.length), join(item.dir, 'dist/happier-plugin-ui'),
          ])),
        }),
      });
      const collect = async directory => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await collect(path);
          else retainedCodeFiles.push(path);
        }
      };
      for (const item of pluginMetadata) await collect(join(item.dir, 'dist/happier-plugin-ui'));
    } finally {
      await rm(preparationDir, { recursive: true, force: true });
    }
  }
  for (const key of Object.keys(entries).filter((key) => key.startsWith(`${outputPrefix}/`))) {
    const target = join(outputDir, `${key}.mjs`);
    await writeFile(target, `export * from './${key.split('/').at(-1)}.js';\n`);
    retainedCodeFiles.push(target);
  }
  await linkInstalledDirectory(join(repoDir, 'node_modules'), join(outputDir, 'node_modules'));
  await linkInstalledDirectory(join(projectDir, 'node_modules'), join(runtimeDir, 'node_modules'));
  if (component === 'daemon') {
    // Only hosts declaring public author packages need a physical author
    // closure; tiny source runtime fixtures have no such package inventory.
    if ((manifest.bundledDependencies ?? []).some(name => workspacePackages.get(name)?.manifest.happier?.publicSdkRelease)) {
      retainedCodeFiles.push(...await emitSourceAuthorPackages({repoDir,projectDir,runtimeDir,workspacePackages,
        build,sourceInputDigests,readSourceInput}));
    }
    const sidecars = await bundleCliSourceSidecars({repoDir,outputDir:join(runtimeDir,'scripts'),build,workspacePackages,requireFromProject});
    retainedCodeFiles.push(...sidecars.codeFiles);
    Object.assign(result.metafile.inputs,sidecars.metafile.inputs);
    Object.assign(result.metafile.outputs,sidecars.metafile.outputs);
    await linkInstalledDirectory(join(projectDir, 'assets'), join(runtimeDir, 'assets'));
    const nativeSource = join(projectDir, 'native/processcustody');
    if (existsSync(join(nativeSource, 'go.mod'))) {
      // Vendor tools retain their installed lifecycle; the first-party helper must
      // match the source daemon's command contract, never an old checkout output.
      const sourceTools = join(projectDir, 'tools');
      for (const entry of existsSync(sourceTools) ? await readdir(sourceTools, { withFileTypes: true }) : []) {
        if (entry.name !== 'unpacked') {
          if (entry.isDirectory()) await linkInstalledDirectory(join(sourceTools, entry.name), join(runtimeDir, 'tools', entry.name));
          else { await mkdir(join(runtimeDir, 'tools'), { recursive: true }); await cp(join(sourceTools, entry.name), join(runtimeDir, 'tools', entry.name)); }
          continue;
        }
        const destination = join(runtimeDir, 'tools/unpacked');
        await mkdir(destination, { recursive: true });
        for (const tool of await readdir(join(sourceTools, 'unpacked'), { withFileTypes: true })) {
          if (/^happier-process-custody(?:\.exe)?$/.test(tool.name)) continue;
          if (tool.isDirectory()) await linkInstalledDirectory(join(sourceTools, 'unpacked', tool.name), join(destination, tool.name));
          else await cp(join(sourceTools, 'unpacked', tool.name), join(destination, tool.name));
        }
      }
      const preparationDir = await mkdtemp(join(runtimeDir, '.source-native-'));
      try {
        const capture = await captureBuildInputFiles({ sourceDir: repoDir, captureDir: preparationDir,
          readPaths: () => readWorkspaceBuildInputs(projectDir, { additionalInputPaths: ['native/processcustody'] })
            .filter(path => path.startsWith('native/')).map(path => relative(repoDir, join(projectDir, path))) });
        for (const path of capture.files) sourceInputDigests[path] = createHash('sha256')
          .update(await readFile(join(preparationDir, path))).digest('hex');
        const ownerPath = join(preparationDir, 'owner.mjs');
        await build({ entryPoints: [join(repoDir, 'packages/cli-common/src/componentArtifacts/stageProcessCustodyRuntime.ts')],
          outfile: ownerPath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
        const { stageProcessCustodyRuntime } = await import(pathToFileURL(ownerPath).href);
        const targetPath = join(preparationDir, 'target.mjs');
        await build({ entryPoints: [join(repoDir, 'packages/cli-common/src/componentArtifacts/targets.ts')],
          outfile: targetPath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
        const { CLI_BINARY_TARGETS, resolveCurrentBinaryTarget } = await import(pathToFileURL(targetPath).href);
        const target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS });
        const { executablePath } = await stageProcessCustodyRuntime({ repoRoot: preparationDir, payloadDir: runtimeDir,
          target, runCommand: (command, args, options) => runCapture(command, args, options) });
        retainedCodeFiles.push(executablePath);
      } finally { await rm(preparationDir, { recursive: true, force: true }); }
    } else await linkInstalledDirectory(join(projectDir, 'tools'), join(runtimeDir, 'tools'));
    const assets = join(projectDir, 'src/plugins/projection/registry/static-assets');
    if (existsSync(assets)) await cp(assets, join(runtimeDir, 'package-dist/plugins/projection/registry/static-assets'), { recursive: true });
  } else {
    for (const name of ['generated', 'assets']) await linkInstalledDirectory(join(projectDir, name), join(runtimeDir, name));
    const copyPrismaInputs = async (source, destination) => {
      await mkdir(destination, { recursive: true });
      for (const name of await readdir(source)) {
        const path = join(source, name);
        const target = join(destination, name);
        if ((await lstat(path)).isDirectory()) await copyPrismaInputs(path, target);
        else if (/\.(?:prisma|sql)$/.test(name) || name === 'migration_lock.toml') {
          // Record exactly the bytes emitted, just like the source-code loader.
          await writeFile(target, await readSourceInput(path));
        }
      }
    };
    if (existsSync(join(projectDir, 'prisma'))) await copyPrismaInputs(join(projectDir, 'prisma'), join(runtimeDir, 'prisma'));
  }
  const distInputs = Object.keys(result.metafile.inputs).filter(file => isFirstPartyBuiltInput(file, workspacePackages));
  if (distInputs.length) throw new Error(`Source runtime consumed first-party built code: ${distInputs.join(', ')}`);
  const externalFirstParty = Object.values(result.metafile.outputs).flatMap((out) => out.imports)
    .filter((item) => item.external && (item.path.startsWith('@happier-dev/') || workspacePackages.has(packageNameOfSpecifier(item.path))));
  if (externalFirstParty.length) throw new Error(`Source runtime left first-party code external: ${externalFirstParty.map((item) => item.path).join(', ')}`);
  await writeFile(join(runtimeDir, 'metafile.json'), JSON.stringify(result.metafile));
  const hash = createHash('sha256');
  for (const absolute of retainedCodeFiles.sort()) {
    hash.update(relative(runtimeDir, absolute));
    hash.update(await readFile(absolute));
  }
  const identity = hash.digest('hex').slice(0, 16);
  const entrypoint = join(runtimeDir, component === 'daemon' ? 'src/index.mjs' : 'sources/main.mjs');
  return {
    identity, entrypoint, runtimeCommand: entrypoint, args: [], runtimeDir, sourceInputDigests,
    ...(component === 'daemon' ? {
      nodeEntrypoint: entrypoint, cliDir: runtimeDir,
      env: {
        HAPPIER_STACK_CLI_ROOT_DIR: runtimeDir,
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
      },
    } : {
      serverDir: runtimeDir, env: {
        ...(dbProvider ? { HAPPIER_DB_PROVIDER: dbProvider } : {}),
        ...((dbProvider ?? (serverComponent === 'happier-server-light' ? 'sqlite' : 'postgres')) === 'sqlite'
          ? { HAPPIER_SQLITE_MIGRATIONS_DIR: join(runtimeDir, 'prisma/sqlite/migrations') } : {}),
      },
      migration: migrationSource || sqliteMigration
        ? { mode: 'external', command: join(runtimeDir, 'scripts/migrate.mjs'), args: [], cwd: runtimeDir }
        : { mode: 'in-process' },
    }),
  };
}
