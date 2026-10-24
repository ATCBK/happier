import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { pathExists } from '../fs/fs.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { coerceHappyMonorepoRootFromPath, getHappyStacksHomeDir, resolveExplicitStackEnvFilePath } from '../paths/paths.mjs';
import { describeJsonOwnerLock, isJsonOwnerFileLockActive, readJsonOwnerLockSnapshot, withJsonOwnerFileLock } from './jsonOwnerFileLock.mjs';
import { collectWorkspacePackageJsonPaths, isYarnWorkspace, readWorkspacePatchPaths } from './workspace_package_manifests.mjs';
import { prepareDependencyConsumersForRefresh } from './dependency_consumers.mjs';
import { inspectUiPostinstallOutputs } from './ui_postinstall.mjs';
import { createWorkspaceBuildWaitNotifier } from './workspaceBuildWaitNotifier.mjs';
import { isPidAlive } from './pids.mjs';

// v5 could publish an --ignore-scripts bootstrap as a complete install.
const REFRESH_STATE_VERSION = 6;
const REFRESH_MARKER = '.happier-stack-dependencies-ready';
// Earlier full admission relied on Yarn's lifecycle reuse and could omit UI
// patches/assets. Only an explicitly completed UI postinstall proves this mode.
const DEPENDENCY_INSTALL_MODE = 'development-full-ui-postinstall-v1';
// Scriptless workspace lifecycle admission still completes mandatory UI outputs.
export const SCRIPTLESS_DEPENDENCY_INSTALL_MODE = 'development-scriptless-ui-postinstall-v1';

export function isDependencyRefreshDisabled(env = process.env) {
  return String(env?.HAPPIER_STACK_SKIP_REFRESH_DEPS ?? '').trim() === '1'
    || String(env?.HAPPIER_STACK_DISABLE_REFRESH_DEPS ?? '').trim() === '1';
}

export function resolveDependencyRefreshMarkerPath(installDir) {
  return join(installDir, 'node_modules', REFRESH_MARKER);
}

export const DEPENDENCY_REFRESH_ASIDE_PREFIX = 'hstack-dependency-refresh-';

// Placement and historical cleanup share these parents. Prefer the executor's
// scratch, then a source sibling; .project/tmp is already excluded by Mutagen.
export async function resolveDependencyRefreshAsideParents(installDir, { scratchRoot = tmpdir() } = {}) {
  const installRoot = await realpath(installDir);
  const sourceRoot = await realpath(coerceHappyMonorepoRootFromPath(installRoot) ?? installRoot);
  const ignoredParent = join(installRoot, '.project', 'tmp');
  const parents = [];
  for (const candidate of [scratchRoot, dirname(sourceRoot), ignoredParent]) {
    let parent;
    try { parent = await realpath(candidate); }
    catch (error) {
      if (error.code === 'ENOENT') parent = resolve(candidate);
      else if (['EACCES', 'EPERM'].includes(error.code)) continue;
      else throw error;
    }
    if (isPathInside(sourceRoot, parent) && parent !== ignoredParent) continue;
    parents.push(parent);
  }
  return [...new Set(parents)];
}

async function createDependencyRefreshAside(installDir, env) {
  const tree = await lstat(join(installDir, 'node_modules')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!tree) return null;
  const device = tree.dev;
  const ignoredParent = join(await realpath(installDir), '.project', 'tmp');
  const parents = await resolveDependencyRefreshAsideParents(installDir, { scratchRoot: env.TMPDIR || tmpdir() });
  for (const parent of parents) {
    try {
      if (parent === ignoredParent) await mkdir(parent, { recursive: true });
      if ((await stat(parent)).dev !== device) continue;
      return await mkdtemp(join(parent, DEPENDENCY_REFRESH_ASIDE_PREFIX));
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(error.code)) throw error;
    }
  }
  throw new Error('No writable same-filesystem location is available to preserve dependencies outside synchronized source');
}

export function resolveDependencyInstallRoot(componentDir) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  return monorepoRoot && existsSync(join(monorepoRoot, 'package.json')) ? monorepoRoot : componentDir;
}

function installDirLockKey(installDir) {
  return createHash('sha256').update(resolve(installDir), 'utf-8').digest('hex');
}

export function resolveDependencyRefreshLockPath(installDir, env = process.env) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(installDir);
  if (monorepoRoot && resolve(monorepoRoot) === resolve(installDir)) {
    return join(monorepoRoot, '.project', 'tmp', 'dependency-install.lock');
  }
  return join(getHappyStacksHomeDir(env), 'cache', 'dependencies', `${installDirLockKey(installDir)}.lock`);
}

const BUILD_DEPENDENCY_CUSTODY_ENV = 'HAPPIER_BUILD_DEPENDENCY_CUSTODY';

function readInheritedDependencyCustody(lockPath, env) {
  let inherited;
  try { inherited = JSON.parse(env[BUILD_DEPENDENCY_CUSTODY_ENV] ?? 'null'); } catch {}
  const owner = readJsonOwnerLockSnapshot(lockPath).owner;
  const owners = Array.isArray(owner?.readers) ? owner.readers : [owner];
  if (Array.isArray(inherited) && (inherited.length === 3 || inherited.length === 4)
    && inherited[0] === lockPath && owners.some(reader => inherited[1] === reader?.pid && inherited[2] === reader?.createdAtMs
      && isPidAlive(Number(reader?.pid)) && (inherited.length === 3 || inherited[3] === reader?.readerId))
    && isJsonOwnerFileLockActive(lockPath)) return owner;
  return null;
}

/** Admission must not wait for more capacity while a containing consumer
 * retains the installed tree. Reuse the same authenticated custody check. */
export function callerHoldsDependencyConsumption(env = process.env) {
  let custody;
  try { custody = JSON.parse(env[BUILD_DEPENDENCY_CUSTODY_ENV] ?? 'null'); } catch { return false; }
  return Array.isArray(custody) && typeof custody[0] === 'string'
    && readInheritedDependencyCustody(custody[0], env) !== null;
}

/**
 * Environment for a package-manager install that runs under the dependency writer lock.
 * First-party workspace postinstall builds take read custody of that same lock, so they inherit
 * the writer's custody instead of waiting on the install that runs them. Unless the caller chose
 * a scope, only the CLI postinstall, which owns real runtime prerequisites, runs as an install
 * side effect; owners prepare other component outputs explicitly.
 */
export function resolveLockedInstallEnv(env = process.env, { lockPath, owner } = {}) {
  const scoped = String(env.HAPPIER_INSTALL_SCOPE ?? '').trim() ? env : { ...env, HAPPIER_INSTALL_SCOPE: 'cli' };
  if (!lockPath || !owner) return scoped;
  return { ...scoped, [BUILD_DEPENDENCY_CUSTODY_ENV]: JSON.stringify([lockPath, owner.pid, owner.createdAtMs]) };
}

// Parallel compiler children consume one containing finite build. Reuse its
// live lock identity instead of queuing them behind their own parent. Writers
// must prepare before this consumption rather than upgrade inherited reads.
export async function withDependencyConsumption({ installDir, env = process.env, signal, wait = true }, consume) {
  signal?.throwIfAborted();
  const lockPath = resolveDependencyRefreshLockPath(installDir, env);
  if (readInheritedDependencyCustody(lockPath, env)) return await consume(env);
  return await withDependencyRefreshLock({ installDir, env, signal, wait, writerPriority: false }, async ({ owner }) => {
    return await consume({ ...env, [BUILD_DEPENDENCY_CUSTODY_ENV]: JSON.stringify([lockPath, owner.pid, owner.createdAtMs, owner.readerId]) });
  });
}

export async function withDependencyRefreshLock({ installDir, env = process.env, signal, wait = true, writerPriority = true }, action) {
  signal?.throwIfAborted();
  const lockPath = resolveDependencyRefreshLockPath(installDir, env);
  const inherited = readInheritedDependencyCustody(lockPath, env);
  if (inherited && inherited.priority !== 'reader') return await action({ lockPath, owner: inherited });
  if (writerPriority && inherited?.priority === 'reader') {
    throw Object.assign(new Error(`HSTACK_WORKSPACE_ADMISSION_ORDER: a dependency writer cannot wait on inherited read custody (${lockPath}); prepare the producer before finite consumption`),
      { code: 'HSTACK_WORKSPACE_ADMISSION_ORDER' });
  }
  return await withJsonOwnerFileLock(action, {
    lockPath,
    errorLabel: 'dependency refresh lock',
    // Synchronous package-manager children can outlive or delay heartbeats.
    // Wait for the live installer; the existing PID check reclaims dead owners.
    timeoutMs: Infinity,
    staleAfterMs: 240_000,
    onWait: createWorkspaceBuildWaitNotifier({ env, label: 'dependency refresh', kind: 'lock' }),
    signal,
    wait,
    // A queued refresh runs immediately after the current finite consumption,
    // before any new independent reader. Descendants retain containing custody.
    priority: writerPriority ? 'writer' : 'reader',
    sharedReaders: true,
  });
}

export function isDependencyRefreshLockActive({ installDir, env = process.env }) {
  return isJsonOwnerFileLockActive(resolveDependencyRefreshLockPath(installDir, env));
}

export function isDependencyRefreshMutationActive({ installDir, env = process.env }) {
  const owner = readJsonOwnerLockSnapshot(resolveDependencyRefreshLockPath(installDir, env)).owner;
  // Legacy untyped custody remains conservatively a possible writer.
  return owner?.priority !== 'reader' && isDependencyRefreshLockActive({ installDir, env });
}

async function collectPatchPaths(installDir) {
  return (await readWorkspacePatchPaths(installDir)).map(patchPath => resolve(installDir, patchPath));
}

async function collectDependencyInputPaths({ installDir, componentDir, versionPreparation = false }) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  const workspaceManifests = monorepoRoot && resolve(installDir) === resolve(monorepoRoot)
    ? await collectWorkspacePackageJsonPaths(monorepoRoot)
    : resolve(installDir) === resolve(componentDir)
      ? []
      : [join(componentDir, 'package.json')];
  const manifestPaths = Array.from(new Set([
    join(installDir, 'package.json'),
    ...(resolve(installDir) === resolve(componentDir) ? [join(componentDir, 'package.json')] : []),
    ...workspaceManifests,
  ].map((path) => resolve(path))));
  const declaredInputs = [];
  for (const manifestPath of manifestPaths) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(manifestPath, 'utf-8'));
    } catch {
      continue;
    }
    const entries = pkg?.happier?.installFreshnessInputs;
    if (entries == null) continue;
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string' || !entry.trim())) {
      throw new Error(`Invalid happier.installFreshnessInputs in ${manifestPath}: expected non-empty relative path strings`);
    }
    const packageDir = dirname(manifestPath);
    for (const entry of entries) {
      if (isAbsolute(entry)) throw new Error(`Invalid happier.installFreshnessInputs entry in ${manifestPath}: paths must be package-relative`);
      const inputPath = resolve(packageDir, entry);
      const outside = relative(packageDir, inputPath);
      if (outside === '..' || outside.startsWith(`..${sep}`)) {
        throw new Error(`Invalid happier.installFreshnessInputs entry in ${manifestPath}: paths must stay inside the package`);
      }
      declaredInputs.push(inputPath);
    }
  }
  // A new physical closure captures the executable prerequisites of the same
  // UI/server producers. This scope belongs to the version format; extending
  // it must not invalidate legacy v6 admissions before consumers migrate.
  if (versionPreparation && existsSync(join(installDir, 'apps/server/scripts/generateClients.ts'))) {
    declaredInputs.push(...[
      'apps/server/tsconfig.json',
      'apps/server/scripts/runTsx.mjs',
      'apps/server/scripts/resolveServerRepoRoot.mjs',
      'apps/server/scripts/resolveTsxCliInvocation.mjs',
      'apps/server/scripts/generateClients.ts',
      'apps/server/scripts/prismaCli.ts',
      'apps/server/scripts/runCommand.ts',
      'apps/server/scripts/schemaSync.ts',
      'apps/server/sources/app/kv/userKvKeyStorage.ts',
      'apps/server/sources/storage/enums.generated.ts',
      'apps/server/prisma/schema.prisma',
      'apps/server/prisma/sqlite/schema.prisma',
      'apps/server/prisma/mysql/schema.prisma',
      'scripts/workspaces/execPnpmCommand.mjs',
      'packages/cli-common/windowsCommandInvocation.mjs',
    ].map(path => join(installDir, path)));
  }
  if (versionPreparation && existsSync(join(installDir, 'apps/ui/tools/codemirror/buildCodeMirrorWebViewBundle.mjs'))) {
    declaredInputs.push(join(installDir, 'apps/ui/sources/components/ui/code/editor/bridge/codeMirrorDecorations.ts'));
  }
  if (versionPreparation && existsSync(join(installDir, 'apps/stack/scripts/utils/proc/dependency_version_resolution.mjs'))) {
    declaredInputs.push(...[
      'apps/stack/scripts/utils/proc/dependency_version_resolution.mjs',
      'apps/stack/scripts/utils/proc/dependency_version_paths.cjs',
      'apps/stack/scripts/utils/proc/workspace_package_manifests.mjs',
      'apps/stack/scripts/utils/fs/fs.mjs',
    ].map(path => join(installDir, path)));
  }
  return Array.from(new Set([
    join(installDir, 'pnpm-lock.yaml'),
    join(installDir, 'pnpm-workspace.yaml'),
    join(installDir, 'package.json'),
    ...workspaceManifests,
    ...await collectPatchPaths(installDir),
    ...declaredInputs,
  ].map((path) => resolve(path)))).sort();
}

function isPathInside(rootPath, candidatePath) {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

function portableRelativePath(rootPath, candidatePath) {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath));
  return relativePath ? relativePath.split(sep).join('/') : '.';
}

function dependencyInputIdentityPath({ installDir, componentDir, inputPath }) {
  if (isPathInside(installDir, inputPath)) {
    return `install:${portableRelativePath(installDir, inputPath)}`;
  }
  if (isPathInside(componentDir, inputPath)) {
    return `component:${portableRelativePath(componentDir, inputPath)}`;
  }
  throw new Error(`Dependency freshness input is outside its installation and component roots: ${inputPath}`);
}

// Package manifests describe dependency edges, platform selection and lifecycle
// inputs. pnpm's workspace settings, overrides and patches are hashed above.
const manifestInstallFields = [
  'name', 'version', 'private', 'dependencies', 'devDependencies', 'optionalDependencies',
  'peerDependencies', 'peerDependenciesMeta', 'bin', 'workspaces', 'resolutions', 'overrides',
  'packageManager', 'engines', 'os', 'cpu', 'flat', 'bundleDependencies', 'bundledDependencies',
];

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableJson(value[key])]));
  }
  return value;
}

function manifestInstallDigest(bytes, { root = false } = {}) {
  const manifest = JSON.parse(bytes.toString('utf8'));
  const inputs = Object.fromEntries(manifestInstallFields
    .filter(field => Object.hasOwn(manifest, field)).map(field => [field, manifest[field]]));
  if (manifest.directories?.bin != null) inputs.directories = { bin: manifest.directories.bin };
  const scripts = Object.fromEntries(['preinstall', 'install', 'postinstall', ...(root ? ['prepublish', 'prepare'] : [])]
    .filter(stage => Object.hasOwn(manifest.scripts ?? {}, stage)).map(stage => [stage, manifest.scripts[stage]]));
  if (Object.keys(scripts).length) inputs.scripts = scripts;
  return createHash('sha256').update(JSON.stringify(stableJson(inputs))).digest('hex');
}

// Lifecycle directories contain their regression tests too. Those files do
// not change installed bytes; executable scripts and assets remain inputs.
function isDependencyTestInputPath(inputPath) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(inputPath);
}

async function readInputSnapshot({ inputPaths, installDir, componentDir }) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(componentDir);
  const workspaceManifests = new Set(monorepoRoot && resolve(installDir) === resolve(monorepoRoot)
    ? (await collectWorkspacePackageJsonPaths(monorepoRoot)).map(path => resolve(path)) : []);
  const rootManifestPath = resolve(join(installDir, 'package.json'));
  const snapshot = [];
  const visit = async (inputPath) => {
    if (isDependencyTestInputPath(inputPath)) return;
    try {
      const stats = await lstat(inputPath);
      const identityPath = dependencyInputIdentityPath({ installDir, componentDir, inputPath });
      if (stats.isFile()) {
        const bytes = await readFile(inputPath);
        snapshot.push({
          path: identityPath,
          kind: 'file',
          digest: createHash('sha256').update(bytes).digest('hex'),
          ...(resolve(inputPath) === rootManifestPath || workspaceManifests.has(resolve(inputPath))
            ? { installDigest: manifestInstallDigest(bytes, { root: resolve(inputPath) === rootManifestPath }) } : {}),
        });
      } else if (stats.isDirectory()) {
        snapshot.push({ path: identityPath, kind: 'directory' });
      } else if (stats.isSymbolicLink()) {
        snapshot.push({
          path: identityPath,
          kind: 'symlink',
          targetDigest: createHash('sha256').update(await readlink(inputPath), 'utf8').digest('hex'),
        });
      } else {
        snapshot.push({ path: identityPath, kind: 'other', size: Number(stats.size) });
      }
      if (stats.isDirectory()) {
        const entries = await readdir(inputPath);
        for (const entry of entries.sort()) await visit(join(inputPath, entry));
      }
    } catch {
      snapshot.push({
        path: dependencyInputIdentityPath({ installDir, componentDir, inputPath }),
        kind: 'missing',
      });
    }
  };
  for (const inputPath of inputPaths) await visit(inputPath);
  return snapshot.sort((a, b) => a.path.localeCompare(b.path));
}

async function resolveDependencyIdentity({ installDir, runtimeIdentity, installMode = DEPENDENCY_INSTALL_MODE }) {
  if (runtimeIdentity) return runtimeIdentity;
  let packageManager = 'unknown';
  try {
    const packageJson = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    const declaredPackageManager = String(packageJson?.packageManager ?? '').trim();
    if (declaredPackageManager) packageManager = declaredPackageManager;
  } catch {
    // A missing or malformed manifest is already represented in the input
    // snapshot. Keep the toolchain identity explicit and deterministic too.
  }
  return {
    packageManager,
    nodeVersion: process.versions.node,
    nodeAbi: process.versions.modules ?? 'unknown',
    platform: process.platform,
    architecture: process.arch,
    installMode,
  };
}

function dependencyIdentitySatisfies(before, after) {
  // Runtime-ready installs also admit source tests. Bootstrap completes UI
  // outputs but cannot prove the other runtime lifecycle prerequisites.
  return before?.packageManager === after?.packageManager
    && before?.nodeVersion === after?.nodeVersion
    && before?.nodeAbi === after?.nodeAbi
    && before?.platform === after?.platform
    && before?.architecture === after?.architecture
    && (before?.installMode === after?.installMode
      || (before?.installMode === DEPENDENCY_INSTALL_MODE
        && after?.installMode === SCRIPTLESS_DEPENDENCY_INSTALL_MODE));
}

function snapshotsMatch(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  // Already-admitted v6 records include test files. Ignore them on both sides
  // without rewriting the record or requiring an installation to upgrade it.
  const currentPaths = new Set(after.map(entry => entry.path));
  before = before.filter(entry => !isDependencyTestInputPath(entry.path)
    // Older v6 capture included every top-level patches/*.patch file. Only
    // current registered/explicit inputs remain authoritative; retain missing
    // registered patches too, so deletion still invalidates their admission.
    && (!/^install:patches\/[^/]+\.patch$/u.test(entry.path) || currentPaths.has(entry.path)));
  after = after.filter(entry => !isDependencyTestInputPath(entry.path));
  if (before.length !== after.length) return false;
  return before.every((entry, index) => {
    const candidate = after[index];
    return entry.path === candidate?.path
      && entry.kind === candidate.kind
      // v6 raw-only admissions still prove unchanged bytes. Once the installer
      // records projected inputs, runtime-only manifest edits remain fresh.
      && (entry.installDigest != null && candidate.installDigest != null
        ? entry.installDigest === candidate.installDigest : entry.digest === candidate.digest)
      && entry.targetDigest === candidate.targetDigest
      && entry.size === candidate.size;
  });
}

const DEPENDENCY_VERSION_FORMAT = 1;
export const DEPENDENCY_VERSION_ROOT_ENV = 'HAPPIER_DEPENDENCY_VERSION_ROOT';
export const DEPENDENCY_VERSION_ID_ENV = 'HAPPIER_DEPENDENCY_VERSION_ID';
export const DEPENDENCY_SOURCE_ROOT_ENV = 'HAPPIER_DEPENDENCY_SOURCE_ROOT';

function dependencyVersionCacheDir(installDir, env) {
  const cache = String(env.HAPPIER_STACK_PM_CACHE_BASE_DIR ?? '').trim()
    || join(getHappyStacksHomeDir(env), 'cache');
  return join(cache, 'dependencies', installDirLockKey(installDir));
}

export function resolveDependencyVersionSelectionPath(installDir, env = process.env) {
  return join(dependencyVersionCacheDir(installDir, env), 'current.json');
}

export function resolveDependencyVersionEnv(env, { dependencyRoot, dependencyIdentity, installRoot }) {
  return { ...env, [DEPENDENCY_VERSION_ROOT_ENV]: dependencyRoot, [DEPENDENCY_VERSION_ID_ENV]: dependencyIdentity,
    [DEPENDENCY_SOURCE_ROOT_ENV]: installRoot };
}

export async function readInheritedDependencyVersion({ installDir, env = process.env }) {
  const dependencyRoot = env[DEPENDENCY_VERSION_ROOT_ENV];
  const dependencyIdentity = env[DEPENDENCY_VERSION_ID_ENV];
  if (!dependencyRoot && !dependencyIdentity) return null;
  const marker = typeof dependencyRoot === 'string'
    && await readJsonIfExists(resolveDependencyRefreshMarkerPath(dependencyRoot));
  const inherited = { version: DEPENDENCY_VERSION_FORMAT, installRoot: resolve(installDir),
    dependencyRoot, dependencyIdentity, identity: marker?.identity, inputs: marker?.inputs };
  const admitted = await admitDependencyVersion({ installDir, env, selected: inherited, marker });
  if (!admitted) throw Object.assign(new Error('Inherited dependency version is not admitted'),
    { code: 'HAPPIER_DEPENDENCY_VERSION_UNAVAILABLE' });
  return admitted;
}

/** Read the admitted physical closure. This does not recertify its immutable
 * bytes against the moving source checkout; new demand compares source inputs. */
export async function readSelectedDependencyVersion({ installDir, env = process.env }) {
  const selected = await readJsonIfExists(resolveDependencyVersionSelectionPath(installDir, env));
  return await admitDependencyVersion({ installDir, env, selected });
}

async function admitDependencyVersion({ installDir, env, selected, marker: capturedMarker }) {
  if (selected?.version !== DEPENDENCY_VERSION_FORMAT || selected.installRoot !== resolve(installDir)
    || typeof selected.dependencyRoot !== 'string' || typeof selected.dependencyIdentity !== 'string'
    || !isPathInside(join(dependencyVersionCacheDir(installDir, env), 'versions'), selected.dependencyRoot)) return null;
  const marker = capturedMarker ?? await readJsonIfExists(resolveDependencyRefreshMarkerPath(selected.dependencyRoot));
  if (marker?.version !== REFRESH_STATE_VERSION || marker.superseded === true
    || marker.dependencyVersion?.version !== DEPENDENCY_VERSION_FORMAT
    || marker.dependencyVersion?.identity !== selected.dependencyIdentity
    || marker.dependencyVersion?.published !== true
    || marker.dependencyVersion?.installRoot !== resolve(installDir)
    || !dependencyIdentitySatisfies(marker.identity, selected.identity)
    || !snapshotsMatch(marker.inputs, selected.inputs)) return null;
  return { ...selected, env: resolveDependencyVersionEnv(env, selected) };
}

async function findPublishedDependencyVersion({ installDir, env, dependencyIdentity, admits }) {
  const versions = join(dependencyVersionCacheDir(installDir, env), 'versions');
  const entries = await readdir(versions, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${dependencyIdentity}-`)) continue;
    const dependencyRoot = join(versions, entry.name);
    const marker = await readJsonIfExists(resolveDependencyRefreshMarkerPath(dependencyRoot));
    // A marker-complete builder still owns cleanup until publication. Reusing
    // its attempt would let that builder delete another consumer's closure.
    if (marker?.dependencyVersion?.published !== true) continue;
    const candidate = await admitDependencyVersion({ installDir, env, marker, selected: {
      version: DEPENDENCY_VERSION_FORMAT, installRoot: resolve(installDir), dependencyRoot,
      dependencyIdentity, identity: marker.identity, inputs: marker.inputs,
    } });
    if (admits(candidate)) return candidate;
  }
  return null;
}

function dependencyVersionIdentity(identity, inputs) {
  // Reuse the canonical install projection: descriptive/runtime-only manifest
  // edits must not produce a second freshness policy or a new installation.
  const projected = inputs.map(({ installDigest, digest, ...entry }) => ({
    ...entry, ...(installDigest != null ? { installDigest } : digest != null ? { digest } : {}),
  }));
  return createHash('sha256').update(JSON.stringify(stableJson({ identity, inputs: projected }))).digest('hex');
}

async function captureDependencyInputs({ installDir, componentDir, dependencyRoot, inputSnapshot }) {
  for (const entry of inputSnapshot) {
    const [domain, ...parts] = entry.path.split(':');
    const path = parts.join(':');
    const sourceRoot = domain === 'install' ? installDir : componentDir;
    const source = resolve(sourceRoot, path);
    const target = resolve(dependencyRoot, relative(installDir, source));
    if (!isPathInside(dependencyRoot, target)) throw new Error('Dependency version inputs must belong to its workspace');
    if (entry.kind === 'missing') continue;
    await mkdir(dirname(target), { recursive: true });
    if (entry.kind === 'directory') await mkdir(target, { recursive: true });
    else if (entry.kind === 'file') await copyFile(source, target);
    else if (entry.kind === 'symlink') {
      // A source link can expose mutable bytes outside the private preparation.
      // Current registered preparation inputs are regular files/directories.
      throw new Error(`Dependency preparation input must be a physical file or directory: ${entry.path}`);
    } else throw new Error(`Unsupported dependency preparation input: ${entry.path}`);
  }
}

/** Prepare a complete workspace closure at one stable physical path. No live
 * install is mutated, and installation never holds source consumption custody.
 * Only the short atomic selection uses the existing dependency writer owner.
 * Callers must complete mandatory UI/Prisma outputs in `prepare` before return. */
export async function prepareDependencyVersion({
  installDir, componentDir = installDir, env = process.env, signal, runtimeIdentity,
  installMode = SCRIPTLESS_DEPENDENCY_INSTALL_MODE,
}, prepare) {
  if (typeof prepare !== 'function') throw new TypeError('prepareDependencyVersion requires a preparation callback');
  signal?.throwIfAborted();
  const versions = join(dependencyVersionCacheDir(installDir, env), 'versions');
  if (isPathInside(installDir, versions)) throw new Error('Dependency versions must be stored outside the source mirror');
  const inputPaths = await collectDependencyInputPaths({ installDir, componentDir, versionPreparation: true });
  const inputSnapshot = await readInputSnapshot({ inputPaths, installDir, componentDir });
  const identity = await resolveDependencyIdentity({ installDir, runtimeIdentity, installMode });
  const dependencyIdentity = dependencyVersionIdentity(identity, inputSnapshot);
  const admits = selected => selected && dependencyIdentitySatisfies(selected.identity, identity)
    && snapshotsMatch(selected.inputs, inputSnapshot);
  const selected = await readSelectedDependencyVersion({ installDir, env });
  if (admits(selected)) return { ...selected, prepared: false, selected: true };
  const inputsChanged = () => Object.assign(new Error('Dependency inputs changed during private preparation; request the current inputs again'),
    { code: 'HAPPIER_DEPENDENCY_INPUTS_CHANGED' });
  const selectRetained = async () => {
    signal?.throwIfAborted();
    const currentPaths = await collectDependencyInputPaths({ installDir, componentDir, versionPreparation: true });
    const current = await readInputSnapshot({ inputPaths: currentPaths, installDir, componentDir });
    const currentIdentity = await resolveDependencyIdentity({ installDir, runtimeIdentity, installMode });
    if (!snapshotsMatch(inputSnapshot, current) || !dependencyIdentitySatisfies(identity, currentIdentity)) throw inputsChanged();
    const winner = await readSelectedDependencyVersion({ installDir, env });
    if (admits(winner)) return winner;
    const retained = await findPublishedDependencyVersion({ installDir, env, dependencyIdentity, admits });
    if (retained) {
      const { env: _consumerEnv, ...record } = retained;
      await writeJsonAtomic(resolveDependencyVersionSelectionPath(installDir, env), record);
    }
    return retained;
  };
  // An absent version must not queue a writer before private preparation.
  // A possible retained version is re-admitted under decision custody before
  // selection, sharing the collector's eventual decision boundary.
  if (await findPublishedDependencyVersion({ installDir, env, dependencyIdentity, admits })) {
    const retained = await withDependencyRefreshLock({ installDir, env, signal }, selectRetained);
    if (retained) return { ...retained, prepared: false, selected: true };
  }
  await mkdir(versions, { recursive: true });
  const dependencyRoot = await mkdtemp(join(versions, `${dependencyIdentity}-`));
  let retained = false;
  let cleanupHandled = false;
  try {
    await captureDependencyInputs({ installDir, componentDir, dependencyRoot, inputSnapshot });
    const capturedComponent = join(dependencyRoot, relative(installDir, componentDir));
    const captured = await readInputSnapshot({ inputPaths: inputPaths.map(path => join(dependencyRoot, relative(installDir, path))),
      installDir: dependencyRoot, componentDir: capturedComponent });
    if (!snapshotsMatch(inputSnapshot, captured)) throw inputsChanged();
    const prepareEnv = { ...env, pnpm_config_package_import_method: 'copy', pnpm_config_side_effects_cache: 'false' };
    delete prepareEnv[BUILD_DEPENDENCY_CUSTODY_ENV];
    delete prepareEnv[DEPENDENCY_VERSION_ROOT_ENV];
    delete prepareEnv[DEPENDENCY_VERSION_ID_ENV];
    delete prepareEnv[DEPENDENCY_SOURCE_ROOT_ENV];
    signal?.throwIfAborted();
    await prepare({ installDir: dependencyRoot, componentDir: capturedComponent, env: prepareEnv, signal });
    signal?.throwIfAborted();
    if (!await pathExists(join(dependencyRoot, 'node_modules'))) throw new Error('Dependency preparation produced no node_modules');
    const candidate = { version: DEPENDENCY_VERSION_FORMAT, installRoot: resolve(installDir),
      dependencyRoot, dependencyIdentity, identity, inputs: inputSnapshot };
    const workerPnpmModules = String(env.HAPPIER_DEV_TARGET_EXECUTION ?? '') === '1'
      && identity.packageManager.startsWith('pnpm@')
      ? await readInputSnapshot({ installDir: dependencyRoot, componentDir: capturedComponent,
        inputPaths: [join(dependencyRoot, 'node_modules/.modules.yaml'), join(dependencyRoot, 'node_modules/.yarn-integrity')] }) : null;
    if (workerPnpmModules && (workerPnpmModules.find(entry => entry.path === 'install:node_modules/.modules.yaml')?.kind !== 'file'
      || workerPnpmModules.find(entry => entry.path === 'install:node_modules/.yarn-integrity')?.kind !== 'missing')) {
      throw new Error('Private pnpm preparation did not produce clean modules metadata');
    }
    const readinessMarker = {
      version: REFRESH_STATE_VERSION, identity, inputs: inputSnapshot, superseded: false,
      dependencyVersion: { version: DEPENDENCY_VERSION_FORMAT, identity: dependencyIdentity,
        installRoot: resolve(installDir), published: false },
      ...(workerPnpmModules ? { workerPnpmModules } : {}),
    };
    await writeJsonAtomic(resolveDependencyRefreshMarkerPath(dependencyRoot), readinessMarker);
    return await withDependencyRefreshLock({ installDir, env, signal }, async () => {
      const winner = await selectRetained();
      if (winner) return { ...winner, prepared: false, selected: true };
      try {
        await writeJsonAtomic(resolveDependencyRefreshMarkerPath(dependencyRoot), { ...readinessMarker,
          dependencyVersion: { ...readinessMarker.dependencyVersion, published: true } });
        await writeJsonAtomic(resolveDependencyVersionSelectionPath(installDir, env), candidate);
        retained = true;
        return { ...candidate, env: resolveDependencyVersionEnv(env, candidate), prepared: true, selected: true };
      } catch (error) {
        // Revoke admission under source decision custody, then leave recursive
        // deletion to the outer finally after custody has been released. If
        // revocation fails, retain the possibly adopted closure instead.
        cleanupHandled = true;
        await unlink(resolveDependencyRefreshMarkerPath(dependencyRoot)).catch(failure => {
          if (failure.code !== 'ENOENT') throw failure;
        });
        cleanupHandled = false;
        throw error;
      }
    });
  } finally {
    if (!retained && !cleanupHandled) await rm(dependencyRoot, { recursive: true, force: true });
  }
}

async function inspectSelfReferentialNodeModulesLink(installDir) {
  const nodeModules = join(installDir, 'node_modules');
  const candidatePath = join(nodeModules, 'node_modules');
  try {
    const stats = await lstat(candidatePath);
    if (!stats.isSymbolicLink()) return null;
    const [nodeModulesRealPath, candidateRealPath] = await Promise.all([
      realpath(nodeModules),
      realpath(candidatePath),
    ]);
    return nodeModulesRealPath === candidateRealPath ? candidatePath : null;
  } catch {
    return null;
  }
}

async function repairSelfReferentialNodeModulesLink(installDir) {
  const candidatePath = await inspectSelfReferentialNodeModulesLink(installDir);
  if (!candidatePath) return false;
  // Remove only the exact self-referential link. `unlink` never traverses its
  // target, so the admitted dependency tree and every package below it remain
  // untouched.
  await unlink(candidatePath);
  return true;
}

export async function inspectDependencyRefresh({ installDir, componentDir = installDir, runtimeIdentity, installMode, env = process.env }) {
  const nodeModules = join(installDir, 'node_modules');
  const inputPaths = await collectDependencyInputPaths({ installDir, componentDir });
  const inputSnapshot = await readInputSnapshot({ inputPaths, installDir, componentDir });
  const dependencyIdentity = await resolveDependencyIdentity({ installDir, runtimeIdentity, installMode });
  // This is the admission record for the installed tree, so keep it with that
  // tree. Warm readers can prove freshness without touching mutation-lock paths,
  // and replacing node_modules naturally invalidates the old publication.
  const markerPath = resolveDependencyRefreshMarkerPath(installDir);
  const markerState = await readJsonIfExists(markerPath).catch(() => null);
  // v6 input freshness never proved that pnpm started from a clean tree: it
  // can retain unrecorded Yarn packages even alongside current .modules.yaml.
  // Worker-only provenance is published by an actual install below, then bound
  // to pnpm's produced metadata without another package inventory or parser.
  const workerPnpmModules = String(env.HAPPIER_DEV_TARGET_EXECUTION ?? '') === '1'
    && dependencyIdentity.packageManager.startsWith('pnpm@')
    ? await readInputSnapshot({ installDir, componentDir, inputPaths: [
        join(nodeModules, '.modules.yaml'), join(nodeModules, '.yarn-integrity'),
      ] }) : null;
  const workerPnpmTreeNeedsCleanInstall = workerPnpmModules !== null && (
    markerState?.identity?.packageManager !== dependencyIdentity.packageManager
    ||
    workerPnpmModules.find(entry => entry.path === 'install:node_modules/.modules.yaml')?.kind !== 'file'
    || workerPnpmModules.find(entry => entry.path === 'install:node_modules/.yarn-integrity')?.kind !== 'missing'
    || !snapshotsMatch(markerState?.workerPnpmModules, workerPnpmModules)
  );
  const nodeModulesPresent = await pathExists(nodeModules);
  const selfReferentialNodeModulesLinkPath = nodeModulesPresent
    ? await inspectSelfReferentialNodeModulesLink(installDir)
    : null;
  if (
    markerState?.version === REFRESH_STATE_VERSION
    && dependencyIdentitySatisfies(markerState.identity, dependencyIdentity)
    && Array.isArray(markerState.inputs)
  ) {
    const inputsMatch = snapshotsMatch(markerState.inputs, inputSnapshot);
    return {
      admitted: nodeModulesPresent && !workerPnpmTreeNeedsCleanInstall && selfReferentialNodeModulesLinkPath === null && markerState.superseded !== true,
      admittedState: nodeModulesPresent && !workerPnpmTreeNeedsCleanInstall && selfReferentialNodeModulesLinkPath === null && markerState.superseded !== true
        // A warm prerequisite action may publish the proven projection without
        // installation. Stale raw admissions never acquire a current baseline.
        ? { ...markerState, inputs: inputsMatch ? inputSnapshot : markerState.inputs } : null,
      required: !nodeModulesPresent
        || workerPnpmTreeNeedsCleanInstall
        || selfReferentialNodeModulesLinkPath !== null
        || markerState.superseded === true
        || !inputsMatch,
      inputPaths,
      inputSnapshot,
      dependencyIdentity,
      markerPath,
      selfReferentialNodeModulesLinkPath,
      workerPnpmModules,
      workerPnpmTreeNeedsCleanInstall,
    };
  }
  return {
    admitted: false,
    admittedState: null,
    required: true,
    inputPaths,
    inputSnapshot,
    dependencyIdentity,
    markerPath,
    selfReferentialNodeModulesLinkPath,
    workerPnpmModules,
    workerPnpmTreeNeedsCleanInstall,
  };
}

// Validation reads the primary installed tree; only an explicit dependency
// refresh may repair it. In particular, skipping installation alone still lets
// PM preparation repair patches, withdraw admission, or reinstall mixed bytes.
export async function assertDependenciesReady({ installDir, componentDir = installDir, env = process.env, runtimeIdentity, installMode }) {
  const requireRefresh = (reason, detail = '') => {
    const error = new Error(`[local] dependencies need refresh at ${installDir} (${reason}${detail ? `: ${detail}` : ''}). Validation does not install or repair primary dependencies. Complete an explicitly authorized refresh through the owning Stack's dependency refresh workflow, then retry validation.`);
    error.code = 'HAPPIER_DEPENDENCIES_NEED_REFRESH';
    error.reason = reason;
    error.installDir = installDir;
    throw error;
  };
  const checkActiveWriter = () => {
    if (isDependencyRefreshMutationActive({ installDir, env })) {
      requireRefresh('refresh-in-progress', describeJsonOwnerLock(resolveDependencyRefreshLockPath(installDir, env)));
    }
  };
  checkActiveWriter();
  const manifest = await readJsonIfExists(join(installDir, 'package.json'));
  const isYarnPredecessor = isYarnWorkspace(manifest);
  // A sibling checkout owns its installed-tree format and lifecycle evidence.
  // Read its canonical decision; never rewrite its admission with this line's
  // pnpm inputs or apply this line's newer UI-postinstall contract to it.
  const inspect = isYarnPredecessor
    ? (await import(pathToFileURL(join(installDir, 'apps/stack/scripts/utils/proc/dependency_refresh.mjs')).href)).inspectDependencyRefresh
    : inspectDependencyRefresh;
  const readiness = await inspect({ installDir, componentDir, runtimeIdentity, installMode, env });
  if (readiness.required) requireRefresh('stale-or-unadmitted');
  if (!isYarnPredecessor) {
    const failures = await inspectUiPostinstallOutputs(join(installDir, 'apps', 'ui'), installDir, { env });
    if (failures.length > 0) requireRefresh('ui-postinstall-incomplete', failures.join('; '));
    const { ensureServerGeneratedProviderOutputs } = await import('./pm.mjs');
    try {
      await ensureServerGeneratedProviderOutputs(join(installDir, 'apps', 'server'), installDir, { env, quiet: true, checkOnly: true });
    } catch {
      requireRefresh('prisma-outputs-incomplete');
    }
  }
  checkActiveWriter();
  return readiness;
}

export async function withDependencyRefresh({
  installDir,
  componentDir = installDir,
  env = process.env,
  onDependenciesReady = null,
  runtimeIdentity,
  installMode,
  refreshExisting = true,
  force = false,
  waitForPendingStart = false,
  signal,
}, refresh) {
  if (typeof refresh !== 'function') throw new TypeError('withDependencyRefresh requires a refresh callback');
  if (onDependenciesReady != null && typeof onDependenciesReady !== 'function') {
    throw new TypeError('withDependencyRefresh requires onDependenciesReady to be a function when provided');
  }
  const shouldRunDependencyReadyAction = onDependenciesReady !== null;
  if (!force && !shouldRunDependencyReadyAction) {
    // Readiness is not mutation: share installed-tree custody with finite
    // consumers, and wait as a reader when an installer is active. Release
    // before requesting a real refresh; never upgrade a held reader to writer.
    const readiness = await withDependencyConsumption({ installDir, env, signal }, () =>
      inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, installMode, env }));
    if (!readiness.required) return { refreshed: false, reason: 'up-to-date' };
    if (!refreshExisting && readiness.selfReferentialNodeModulesLinkPath === null) {
      return { refreshed: false, reason: 'refresh-disabled' };
    }
  }

  const refreshUnderLock = () => withDependencyRefreshLock({ installDir, env, signal }, async ({ lockPath, owner }) => {
    const afterDependencyLock = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, installMode, env });
    if (!force && !afterDependencyLock.required && !shouldRunDependencyReadyAction) return { refreshed: false, reason: 'up-to-date' };
    let stacksNeedingRestart = [];
    let priorTreeDirectory = null;
    const mutate = async () => {
      let beforeMutation = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, installMode, env });
      let result = { refreshed: false, reason: 'up-to-date' };
      if (beforeMutation.selfReferentialNodeModulesLinkPath !== null) {
        const repaired = await repairSelfReferentialNodeModulesLink(installDir);
        if (repaired) {
          beforeMutation = await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, installMode, env });
          result = {
            refreshed: false,
            reason: 'repaired-self-referential-node-modules-link',
          };
        }
      }
      if (force || beforeMutation.required || onDependenciesReady) {
        const didRefresh = (force || beforeMutation.required) && refreshExisting;
        if (didRefresh && beforeMutation.workerPnpmTreeNeedsCleanInstall) {
          const nodeModules = join(installDir, 'node_modules');
          console.log(`[local] reconciling unproven worker pnpm installation: ${nodeModules}`);
          // Keep the old tree and its exact admission together until the new
          // installation and prerequisites succeed. Same-device placement stays
          // outside synchronized source and under the existing dependency writer.
          const aside = await createDependencyRefreshAside(installDir, env);
          if (aside) {
            try {
              await rename(nodeModules, join(aside, 'node_modules'));
              priorTreeDirectory = aside;
            } catch (error) {
              await rm(aside, { recursive: true, force: true });
              if (error?.code !== 'ENOENT') throw error;
            }
          }
        }
        // A ready action can repair generated/patch outputs even on a warm
        // install. Withdraw admission before either mutation, and publish only
        // after every prerequisite succeeds under the same writer lock.
        await unlink(beforeMutation.markerPath).catch(error => {
          if (error?.code !== 'ENOENT') throw error;
        });
        // The refresh runs under this writer lock; its installer spawns with this environment.
        if (didRefresh) await refresh({ env: resolveLockedInstallEnv(env, { lockPath, owner }) });
        if (onDependenciesReady) await onDependenciesReady({ env: resolveLockedInstallEnv(env, { lockPath, owner }) });
        // Ready-only repairs preserve callers' explicit no-install policy.
        // They cannot certify stale dependency inputs as newly installed.
        if ((force || beforeMutation.required) && !didRefresh) {
          // Last-green consumers may repair mandatory outputs without
          // installing newer source inputs. Restore only the prior coherent
          // admission: the normal installer must still see those inputs stale.
          if (beforeMutation.admittedState) {
            await writeJsonAtomic(beforeMutation.markerPath, beforeMutation.admittedState);
          }
          return { ...result, reason: 'refresh-disabled' };
        }
        if (!didRefresh && beforeMutation.admittedState) {
          // Completing outputs did not replace the installed tree. Retain its
          // full admission when a scriptless consumer repairs warm outputs.
          await writeJsonAtomic(beforeMutation.markerPath, beforeMutation.admittedState);
          return result;
        }
        const refreshedInputPaths = await collectDependencyInputPaths({ installDir, componentDir });
        const refreshedInputSnapshot = await readInputSnapshot({
          inputPaths: refreshedInputPaths,
          installDir,
          componentDir,
        });
        const refreshedDependencyIdentity = await resolveDependencyIdentity({ installDir, runtimeIdentity, installMode });
        const installed = beforeMutation.workerPnpmModules !== null && didRefresh
          ? await inspectDependencyRefresh({ installDir, componentDir, runtimeIdentity, installMode, env }) : null;
        if (installed && (
          installed.workerPnpmModules?.find(entry => entry.path === 'install:node_modules/.modules.yaml')?.kind !== 'file'
          || installed.workerPnpmModules?.find(entry => entry.path === 'install:node_modules/.yarn-integrity')?.kind !== 'missing'
        )) {
          throw Object.assign(new Error('Worker pnpm installation did not produce clean modules metadata'),
            { code: 'HAPPIER_DEPENDENCIES_NEED_REFRESH' });
        }
        const superseded = !snapshotsMatch(beforeMutation.inputSnapshot, refreshedInputSnapshot)
          || !dependencyIdentitySatisfies(beforeMutation.dependencyIdentity, refreshedDependencyIdentity);
        await writeJsonAtomic(beforeMutation.markerPath, {
          version: REFRESH_STATE_VERSION,
          identity: superseded ? beforeMutation.dependencyIdentity : refreshedDependencyIdentity,
          // If inputs advanced during the refresh, publish the admitted generation
          // as superseded. The next owner schedules exactly one successor instead
          // of treating the install as an unknown/unpublished attempt forever.
          inputs: superseded ? beforeMutation.inputSnapshot : refreshedInputSnapshot,
          superseded,
          ...(installed ? { workerPnpmModules: installed.workerPnpmModules } : {}),
          stacksNeedingRestart: didRefresh ? stacksNeedingRestart : [],
        });
        if (didRefresh) {
          result = { refreshed: true, reason: force ? 'forced-refresh' : 'stale-inputs', stacksNeedingRestart };
          if (stacksNeedingRestart.length) {
            console.log(`[local] Stacks running on pre-refresh dependencies; restart at the next owner boundary: ${stacksNeedingRestart.join(', ')}`);
          }
        }
      }
      return result;
    };
    // The verifier can itself depend on the new dependency inputs. Probe it
    // only when reusing installed bytes; a scheduled install precedes probing.
    const willRefresh = (force || afterDependencyLock.required) && refreshExisting;
    const uiPrerequisites = onDependenciesReady && !willRefresh
      ? await inspectUiPostinstallOutputs(join(installDir, 'apps', 'ui'), installDir, { env })
      : [];
    const componentPrerequisites = onDependenciesReady && !willRefresh && resolve(componentDir) !== resolve(join(installDir, 'apps', 'ui'))
      ? await inspectUiPostinstallOutputs(componentDir, installDir, { env })
      : [];
    let serverPrerequisitesRequired = false;
    if (onDependenciesReady && !willRefresh) {
      // The ready action can replace generated provider clients even when
      // package inputs/UI outputs are current. Use the generator's own check
      // before withdrawing admission or permitting any repair during a start.
      const { ensureServerGeneratedProviderOutputs } = await import('./pm.mjs');
      try {
        await ensureServerGeneratedProviderOutputs(join(installDir, 'apps', 'server'), installDir, {
          env: resolveLockedInstallEnv(env, { lockPath, owner }), quiet: true, checkOnly: true, signal,
        });
      } catch {
        signal?.throwIfAborted();
        serverPrerequisitesRequired = true;
      }
    }
    if (willRefresh
      || afterDependencyLock.selfReferentialNodeModulesLinkPath !== null
      || uiPrerequisites.length > 0 || componentPrerequisites.length > 0 || serverPrerequisitesRequired) {
      ({ stacksNeedingRestart } = await prepareDependencyConsumersForRefresh({ installDir, env }));
    }
    let result;
    try {
      result = await mutate();
    } catch (error) {
      if (priorTreeDirectory) {
        await rm(join(installDir, 'node_modules'), { recursive: true, force: true });
        await rename(join(priorTreeDirectory, 'node_modules'), join(installDir, 'node_modules'));
        await rm(priorTreeDirectory, { recursive: true, force: true });
      }
      throw error;
    }
    if (priorTreeDirectory) await rm(priorTreeDirectory, { recursive: true, force: true });
    return result;
  });
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await refreshUnderLock();
    } catch (error) {
      if (!waitForPendingStart || error?.code !== 'HAPPIER_DEPENDENCY_STACK_START_IN_PROGRESS'
        || typeof error.pendingStackBaseDir !== 'string') throw error;
      const callerEnvFile = resolveExplicitStackEnvFilePath(env);
      // A start cannot await its own readiness. Its existing explicit retry
      // contract remains authoritative; only independent readers opt in.
      if (callerEnvFile && resolve(dirname(callerEnvFile)) === resolve(error.pendingStackBaseDir)) throw error;
      // withDependencyRefreshLock has released both custody and its priority
      // ticket here. Keeping either would deadlock the start's later readers.
      const { waitForPendingSourcePreparation } = await import('../../runtime/shared/pending_source_start.mjs');
      await waitForPendingSourcePreparation({ stackBaseDir: error.pendingStackBaseDir, env, signal });
    }
  }
}
