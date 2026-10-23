import { relative, resolve, sep } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveWorkspaceBuildMode, WORKSPACE_BUILD_MODE_ENV } from '../../../../../scripts/workspaces/workspaceChildBuildEnv.mjs';
import { requiresTypeScriptAdmission } from '../../../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';
import { runWorkspaceBuildAdmission } from '../proc/workspace_build_admission.mjs';
import { runCommand } from '../proc/proc.mjs';
import { resolveRemoteCommandPolicy } from './remote_commands.mjs';
import { BuildInputDriftError, withSingleTrailingBuildPass } from '../../../../../scripts/workspaces/buildInputConvergence.mjs';
import { writeJsonAtomic } from '../fs/json.mjs';
import { resolveRemoteValidationPreparationEnv } from './validation_env.mjs';
export { resolveRemoteValidationPreparationEnv } from './validation_env.mjs';

// The explicit finite batch is also the validation boundary for automatic
// dispatch. Dispatch remains reader-only until its contention/portability gates
// pass; the batch itself never selects another worker.
async function prepareTypecheckBatch({ repoDir, componentRelativeDirs, batchReader, env, signal }) {
  if (typeof batchReader.command !== 'string' || !batchReader.command
    || !Array.isArray(batchReader.args) || batchReader.args.some(value => typeof value !== 'string')) {
    throw new Error('A typecheck batch requires a finite reader command');
  }
  const components = [...new Set(componentRelativeDirs)].map(component =>
    resolveComponentDir(repoDir, component).componentDir);
  const owner = await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
  const cwd = resolveComponentDir(repoDir, relative(repoDir, batchReader.cwd ?? repoDir)).componentDir;
  const policy = resolveRemoteCommandPolicy([batchReader.command, ...batchReader.args], { cwd, repoRoot: repoDir });
  const readerAdmissionClass = policy.heavyClass || 'compilation';
  return await withSingleTrailingBuildPass({ run: async () => {
    const resources = await owner.collectWorkspaceBuildBatchResources(components, { env, admissionClass: readerAdmissionClass });
    const resultDir = await mkdtemp(resolve(tmpdir(), 'happier-typecheck-batch-result-'));
    const resultPath = resolve(resultDir, 'result.json');
    const request = { repoDir, components, reader: { command: batchReader.command, args: batchReader.args, cwd },
      identity: resources.identity, readerAdmissionClass, resultPath };
    try {
      const result = await runWorkspaceBuildAdmission({
        command: process.execPath,
        args: [fileURLToPath(import.meta.url), '--typecheck-batch-worker', JSON.stringify(request)],
        locks: resources.locks, admissionClass: resources.admissionClass,
        admissionRequired: requiresTypeScriptAdmission({ env }), cwd: repoDir, env, signal,
      });
      // The native process is terminal here: its old resources and capacity
      // have unwound before the existing single trailing pass can recollect.
      if (result.error) throw result.error;
      if (result.status !== 0 || result.signal) {
        const failure = await readFile(resultPath, 'utf8').then(JSON.parse).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!result.signal && failure?.code === 'HSTACK_WORKSPACE_BUILD_RESOURCES_CHANGED') {
          throw new BuildInputDriftError(failure.message);
        }
        throw Object.assign(new Error('Typecheck preparation batch failed'),
          { exitCode: result.status, signal: result.signal });
      }
      return { ok: true, batch: true };
    } finally { await rm(resultDir, { recursive: true, force: true }); }
  } });
}

async function runTypecheckBatchWorker(request) {
  const env = { ...process.env, [WORKSPACE_BUILD_MODE_ENV]: 'strict' };
  const owner = await import('../../../../../scripts/workspaces/ensureWorkspacePackagesBuilt.mjs');
  // Re-read the graph after joint admission: a queued batch may have observed
  // source membership from before another lane changed its dependencies.
  const current = await owner.collectWorkspaceBuildBatchResources(request.components, { env,
    admissionClass: request.readerAdmissionClass });
  if (current.identity !== request.identity) {
    throw Object.assign(new Error('Typecheck batch resources changed while queued; retry after releasing admission'),
      { code: 'HSTACK_WORKSPACE_BUILD_RESOURCES_CHANGED' });
  }
  const started = performance.now();
  const result = await owner.ensureWorkspacePackagesBuiltByName(request.repoDir, current.packageNames, {
    env, buildMode: 'strict', maxConcurrentBuilds: 1, inheritedAdmission: true,
    visitedNames: current.consumerOnlyPackageNames,
  });
  for (const component of request.components) await owner.syncWorkspaceComponentBundledDependencies(component, { env });
  process.stderr.write(`[typecheck-preparation] ready ${JSON.stringify({
    built: result.built, elapsedMs: Math.round(performance.now() - started),
  })}\n`);
  const readerResult = await runCommand(request.reader.command, request.reader.args, {
    cwd: request.reader.cwd, env, stdio: 'inherit',
  });
  if (readerResult.error) throw readerResult.error;
  process.exitCode = readerResult.status ?? 1;
  if (readerResult.signal) process.exitCode = 1;
}

async function prepareCliSourceNativeCustody(repoDir, env) {
  const setupModule = pathToFileURL(resolve(repoDir, 'apps/cli/src/test-setup.ts')).href;
  const sourceRuntime = resolve(repoDir, 'packages/cli-common/registerSourceRuntime.mjs');
  const projectRoot = resolve(repoDir, 'apps/cli');
  const sourceArgs = ['--import', sourceRuntime, '--input-type=module', '--eval'];
  const result = await runWorkspaceBuildAdmission({
    command: process.execPath,
    args: [...sourceArgs,
      `import { prepareNativeCustody } from ${JSON.stringify(setupModule)};\nawait prepareNativeCustody(process.argv[1]);`,
      projectRoot],
    // Native compilation is prepared before the test reader's reservation.
    // Reuse its existing six-GiB producer envelope and publication resource;
    // neither capacity nor the lease survives into the validation payload.
    admissionClass: 'package-dist', admissionRequired: requiresTypeScriptAdmission({ env }),
    locks: [{ path: resolve(repoDir, '.project/tmp/cli-dist-build.lock'), errorLabel: 'CLI native process custody lock' }],
    repoDir, cwd: repoDir, env, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    throw Object.assign(new Error(result.signal
      ? `CLI native process custody preparation terminated by ${result.signal}`
      : `CLI native process custody preparation exited with status ${String(result.status)}`),
    { exitCode: result.status, signal: result.signal });
  }
}

function resolveComponentDir(repoDir, componentRelativeDir) {
  const repositoryRoot = resolve(repoDir);
  const raw = String(componentRelativeDir ?? '.').trim() || '.';
  if (/\0|\r|\n/.test(raw) || raw.replaceAll('\\', '/').split('/').includes('..')) {
    throw new Error('[dev-targets] validation component must stay inside the synchronized repository');
  }
  const componentDir = resolve(repositoryRoot, raw);
  const componentPath = relative(repositoryRoot, componentDir);
  if (componentPath === '..' || componentPath.startsWith(`..${sep}`)) {
    throw new Error('[dev-targets] validation component must stay inside the synchronized repository');
  }
  return { componentDir, componentPath };
}

export async function prepareRemoteValidationWorkspace({
  repoDir = resolve(process.cwd()),
  componentRelativeDir = '.',
  componentRelativeDirs = [componentRelativeDir],
  batchReader,
  validationKind = 'runtime',
  requiredTools = '',
  defaultBuildMode = validationKind === 'runtime' ? 'source-dev' : 'strict',
  env = process.env,
  signal,
  loadWorkspaceBuildOwner = async () => await import('../proc/pm.mjs'),
  loadCliBuildOwner = async () => await import('../../../../cli/scripts/buildSharedDeps.mjs'),
} = {}) {
  if (validationKind === 'typecheck' && batchReader) {
    return await prepareTypecheckBatch({ repoDir, componentRelativeDirs, batchReader,
      env: { ...env, [WORKSPACE_BUILD_MODE_ENV]: 'strict' }, signal });
  }
  env = { ...env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    buildMode: env[WORKSPACE_BUILD_MODE_ENV] ?? defaultBuildMode, env,
  }) };
  const { componentDir, componentPath } = resolveComponentDir(repoDir, componentRelativeDir);
  if (!componentPath) return { ok: true, built: [], skipped: ['repository-root-script-owned'] };
  const normalizedComponentPath = componentPath.replaceAll('\\', '/');
  if (validationKind === 'source-test') {
    if (normalizedComponentPath === 'apps/cli' && requiredTools.split(/\s+/u).includes('go')) {
      await prepareCliSourceNativeCustody(repoDir, env);
    }
    return { ok: true, built: [], skipped: ['workspace-source-test'] };
  }
  if (validationKind === 'typecheck') {
    // Automatic declaration preparation is withdrawn after the DECLPREP C3
    // fleet rollback criterion fired. Typechecks remain readers until an
    // approved continuation establishes a replacement at the compiler owner.
    return { ok: true, built: [], skipped: ['workspace-typecheck-reader'] };
  }
  env = resolveRemoteValidationPreparationEnv(env, validationKind, defaultBuildMode);
  const livePluginHost = normalizedComponentPath === 'apps/cli' || normalizedComponentPath === 'apps/ui';
  const buildOptions = { env, ...(livePluginHost ? { isolatePluginFailures: true } : {}) };

  const { ensureWorkspacePackagesBuiltForComponent } = await loadWorkspaceBuildOwner();
  if (livePluginHost) {
    const {
      resolveCliBundledWorkspacePackageNames,
      publishBundledPluginArtifactsAfterWorkspaceBuild,
    } = await loadCliBuildOwner();
    // The CLI bundled selection mixes host workspaces with bundled plugins.
    // The canonical publication owner selects the bundled-plugin subset — and
    // skips publication when it is empty — so mixed selections never reach the
    // plugin-only generator CLI.
    await publishBundledPluginArtifactsAfterWorkspaceBuild({
      repoRoot: resolve(repoDir),
      workspaceNames: resolveCliBundledWorkspacePackageNames({ repoRoot: resolve(repoDir) }),
      env,
      publicationMode: 'live',
      // These generated files are deliberately replica-owned and absent from
      // Mutagen. Preparation must materialize them, not check a nonexistent
      // local projection or synchronize the primary checkout's stale bytes.
      // Only materialize outputs excluded from the one-way source replica.
      // Source-synchronized projections remain untouched so the following
      // check can still detect drift in the authoritative checkout bytes.
      bundledPluginArtifactPublication: { mode: 'write', targetOwnedOnly: true },
    });
  }
  const result = await ensureWorkspacePackagesBuiltForComponent(componentDir, buildOptions);
  if (normalizedComponentPath === 'apps/ui') {
    // The UI owns only its bundled UI package subset. The publisher above
    // makes source-derived plugin manifests and immutable artifact outputs
    // current before either component preparation can validate a newly
    // declared artifact, while this pass still prepares the complete CLI host
    // closure consumed by the UI validation command.
    await ensureWorkspacePackagesBuiltForComponent(resolve(repoDir, 'apps', 'cli'), buildOptions);
  }
  return result;
}

function readComponentRelativeDir(argv) {
  const argument = argv.find((value) => value.startsWith('--component-relative-dir='));
  if (!argument) throw new Error('usage: remote_validation_preparation.mjs --component-relative-dir=PATH');
  return argument.slice('--component-relative-dir='.length);
}

function readValidationKind(argv) {
  const argument = argv.find((value) => value.startsWith('--validation-kind='));
  return argument ? argument.slice('--validation-kind='.length) : 'runtime';
}

const entryPath = String(process.argv[1] ?? '').trim();
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  if (process.argv[2] === '--typecheck-batch-worker') {
    const request = JSON.parse(process.argv[3]);
    try { await runTypecheckBatchWorker(request); }
    catch (error) {
      await writeJsonAtomic(request.resultPath, { code: error.code, message: error.message });
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (process.argv[2] === '--typecheck-batch') {
    const args = process.argv.slice(3);
    const delimiter = args.indexOf('--');
    if (delimiter < 0 || !args[delimiter + 1]) throw new Error('Typecheck batch requires -- followed by its finite reader');
    const options = args.slice(0, delimiter);
    const repo = options.find(value => value.startsWith('--repo-dir='));
    const repoDir = repo ? resolve(repo.slice('--repo-dir='.length)) : resolve(process.cwd());
    const cwd = options.find(value => value.startsWith('--reader-cwd='));
    try {
      await prepareRemoteValidationWorkspace({ repoDir, validationKind: 'typecheck',
        componentRelativeDirs: options.filter(value => value.startsWith('--component-relative-dir='))
          .map(value => value.slice('--component-relative-dir='.length)),
        batchReader: { command: args[delimiter + 1], args: args.slice(delimiter + 2),
          cwd: cwd ? resolve(repoDir, cwd.slice('--reader-cwd='.length)) : repoDir },
      });
    } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }
  } else {
  const repo = process.argv.slice(2).find(value => value.startsWith('--repo-dir='));
  const repoDir = repo ? resolve(repo.slice('--repo-dir='.length)) : resolve(process.cwd());
  const executorRepoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const kind = readValidationKind(process.argv.slice(2));
  const mode = process.argv.slice(2).find(value => value.startsWith('--default-build-mode='))?.slice('--default-build-mode='.length)
    ?? (kind === 'runtime' ? 'source-dev' : 'strict');
  const env = { ...process.env, [WORKSPACE_BUILD_MODE_ENV]: resolveWorkspaceBuildMode({
    buildMode: process.env[WORKSPACE_BUILD_MODE_ENV] ?? mode, env: process.env,
  }) };
  if (repo && resolve(repoDir) !== resolve(executorRepoRoot) && kind !== 'source-test' && kind !== 'typecheck') {
    // The selected checkout owns its package graph and emitted output.
    const { ensureWorkspacePackagesBuiltForComponent } = await import(pathToFileURL(resolve(repoDir, 'scripts/workspaces/ensureWorkspacePackagesBuilt.mjs')).href);
    await ensureWorkspacePackagesBuiltForComponent(resolveComponentDir(repoDir, readComponentRelativeDir(process.argv.slice(2))).componentDir, { env: resolveRemoteValidationPreparationEnv(env, kind, mode) });
  } else {
    await prepareRemoteValidationWorkspace({
      repoDir,
      componentRelativeDir: readComponentRelativeDir(process.argv.slice(2)),
      validationKind: kind,
      requiredTools: process.argv.slice(2).find(value => value.startsWith('--required-tools='))?.slice('--required-tools='.length) ?? '',
      env,
    });
  }
  }
}
