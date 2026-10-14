import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFakeBin } from './fake_bin_harness.mjs';
import { withDependencyRefresh } from '../../utils/proc/dependency_refresh.mjs';

const sourceRoot = resolve(import.meta.dirname, '../../../../..');

/** A simulated physical worker cannot inherit the runner's custody or CPU budget.
 * Layer intentional fixture worker settings onto the returned environment.
 */
export function buildNativeAdmissionFixtureEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !key.startsWith('HAPPIER_HEAVYWEIGHT_ADMISSION_')
    && !key.startsWith('HAPPIER_WORKSPACE_DIST_BUILD_LOCK_')
    && !['HAPPIER_BUILD_DEPENDENCY_CUSTODY', 'VITEST_MAX_THREADS', 'VITEST_MIN_THREADS',
      'VITEST_MAX_FORKS', 'VITEST_MIN_FORKS', 'GOMAXPROCS'].includes(key)));
}

/** Remap only the fixed OS-state filesystem boundary, never a production flag.
 * Real admission, kernel identity, locking and class policy remain unchanged.
 */
export async function installNativeAdmissionFixture({ root, admissionRoot = join(root, 'host-admission'), observedPidsPath = null, prepareDependencies = false }) {
  const checkout = join(root, 'native-owner');
  const bin = join(checkout, 'apps/stack/bin');
  const proc = join(checkout, 'apps/stack/scripts/utils/proc');
  const targets = join(checkout, 'apps/stack/scripts/utils/dev_targets');
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(proc, { recursive: true }), mkdir(targets, { recursive: true })]);
  const launcher = join(bin, 'hstack-exec');
  await Promise.all([
    copyFile(join(sourceRoot, 'apps/stack/bin/hstack-exec'), launcher),
    copyFile(join(sourceRoot, 'apps/stack/bin/hstack-dev-target-control'), join(bin, 'hstack-dev-target-control')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/proc/native_process_identity.sh'), join(proc, 'native_process_identity.sh')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/native_command_policy.sh'), join(targets, 'native_command_policy.sh')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/native_sync_readiness.sh'), join(targets, 'native_sync_readiness.sh')),
    copyFile(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh'), join(targets, 'remote_execution_custody.sh')),
  ]);
  // Native runtime dispatch consumes these real source preparation owners.
  // Forward the entry identity too: a plain symlink skips their CLI main guard
  // because Node resolves import.meta.url to the original module's real path.
  for (const entry of ['remote_dependency_bootstrap.mjs', 'remote_validation_preparation.mjs', 'native_execution_projection.mjs']) {
    const canonicalEntry = join(sourceRoot, 'apps/stack/scripts/utils/dev_targets', entry);
    await writeFile(join(targets, entry), `process.argv[1] = ${JSON.stringify(canonicalEntry)}; await import(${JSON.stringify(pathToFileURL(canonicalEntry).href)});\n`);
  }
  const state = await readFile(join(sourceRoot, 'apps/stack/scripts/utils/proc/native_host_admission_state.sh'), 'utf8');
  const quoted = `'${admissionRoot.replaceAll("'", "'\\''")}'`;
  await writeFile(join(proc, 'native_host_admission_state.sh'), state.replace(/'\/tmp\/happier-heavyweight-admission-v\d+'/, quoted));
  // This fixture is an isolated physical worker, not the test runner's host.
  // Replace only OS enumeration; real RSS/ancestry for explicitly included
  // fixture processes and the production observer's domain logic stay real.
  const observer = pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/service_memory.mjs')).href;
  const commandPolicy = pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/remote_commands.mjs')).href;
  await writeFile(join(targets, 'remote_commands.mjs'), `export * from ${JSON.stringify(commandPolicy)};
import { runRemoteCommandPolicyCli } from ${JSON.stringify(commandPolicy)};
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runRemoteCommandPolicyCli();
}
`);
  const diskObserver = pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/dev_targets/worker_disk_budget.mjs')).href;
  const workspaceAdmissionWorker = pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/workspace_build_admission.mjs')).href;
  await writeFile(join(proc, 'workspace_build_admission.mjs'), `export * from ${JSON.stringify(workspaceAdmissionWorker)};
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWorkspaceBuildAdmissionWorker, runWorkspaceBuildAdmission as runOwner } from ${JSON.stringify(workspaceAdmissionWorker)};
export async function runWorkspaceBuildAdmission(options) { return await runOwner({ ...options, launcherPath: ${JSON.stringify(launcher)} }); }
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runWorkspaceBuildAdmissionWorker(process.argv.slice(2));
`);
  await writeFile(join(targets, 'worker_disk_budget.mjs'), `import { runWorkerDiskBudgetCommand } from ${JSON.stringify(diskObserver)}; await runWorkerDiskBudgetCommand();\n`);
  if (prepareDependencies) {
    // A real, dependency-free workspace keeps preparation on its actual
    // readiness/graph owners without reading or repairing the runner's tree.
    await mkdir(join(checkout, 'node_modules'), { recursive: true });
    await mkdir(join(checkout, 'scripts/workspaces'), { recursive: true });
    await writeFile(join(checkout, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'], packageManager: 'yarn@1.22.22' }));
    await writeFile(join(checkout, 'yarn.lock'), '# dependency-free native worker fixture\n');
    for (const component of ['stack', 'cli', 'ui', 'server']) {
      await mkdir(join(checkout, 'apps', component), { recursive: true });
      await writeFile(join(checkout, 'apps', component, 'package.json'), JSON.stringify({ name: `@fixture/${component}`, private: true }));
    }
    const workspaceOwner = pathToFileURL(join(sourceRoot, 'scripts/workspaces/ensureWorkspacePackagesBuilt.mjs')).href;
    const artifactTarget = pathToFileURL(join(sourceRoot, 'packages/cli-common/componentArtifactTarget.mjs')).href;
    await mkdir(join(checkout, 'packages/cli-common'), { recursive: true });
    await writeFile(join(checkout, 'packages/cli-common/componentArtifactTarget.mjs'), `export * from ${JSON.stringify(artifactTarget)};\n`);
    await writeFile(join(checkout, 'scripts/workspaces/ensureWorkspacePackagesBuilt.mjs'), `export * from ${JSON.stringify(workspaceOwner)};\n`);
    for (const [domain, owner] of [['workspaces', workspaceOwner], ['process', pathToFileURL(join(sourceRoot, 'apps/stack/scripts/utils/proc/proc.mjs')).href]]) {
      const output = join(checkout, 'packages/cli-common/dist', domain);
      await mkdir(output, { recursive: true });
      await writeFile(join(output, 'index.js'), `export * from ${JSON.stringify(owner)};\n`);
    }
    // The installer boundary has no dependencies to extract. The real owner
    // records this tree only after that installation response completes.
    await withDependencyRefresh({ installDir: checkout, componentDir: join(checkout, 'apps/stack'),
      env: { ...buildNativeAdmissionFixtureEnv(), HAPPIER_STACK_HOME_DIR: root } }, async () => {});
  }
  await writeFile(join(proc, 'service_memory.mjs'), `
import { readFileSync } from 'node:fs';
import { readLinuxWorkerProcesses, readWorkerMemoryReservations, renderWorkerMemoryReservationRows } from ${JSON.stringify(observer)};
const observedPidsPath = ${JSON.stringify(observedPidsPath)};
const selected = observedPidsPath ? new Set(JSON.parse(readFileSync(observedPidsPath, 'utf8'))) : new Set();
const processes = selected.size ? new Map([...readLinuxWorkerProcesses()].filter(([pid]) => selected.has(pid))) : new Map();
const argument = process.argv.slice(2).find(value => value.startsWith('--admission-root='));
let previousProgress = null;
if (process.argv.includes('--include-owner-progress')) {
  try { previousProgress = JSON.parse(readFileSync(0, 'utf8')); } catch {}
}
const sample = readWorkerMemoryReservations({ admissionRoot: argument?.slice('--admission-root='.length), readProcesses: () => processes, includeAdmittedRss: process.argv.includes('--include-admitted-rss'), includeOwnerProgress: process.argv.includes('--include-owner-progress'), previousProgress });
process.stdout.write(renderWorkerMemoryReservationRows(sample));
`);
  return { launcher, admissionRoot };
}

/** Independent fixture worker: redirect only process launch and OS memory
 * observation. Native admission, authenticated leases and publication stay real.
 */
export async function installWorkspaceAdmissionProcessFixture(t, root) {
  if (process.platform !== 'linux') return { env: buildNativeAdmissionFixtureEnv(), launcher: null };
  const { launcher } = await installNativeAdmissionFixture({ root });
  const { binDir } = writeFakeBin({ root, binDirName: 'native-owner/node_modules/.bin', name: 'awk', content: `#!/bin/sh
case "$*" in
  */proc/meminfo*) printf '73400320 73400320\\n' ;;
  */proc/pressure/memory*) printf '0\\n' ;;
  *) exec /usr/bin/awk "$@" ;;
esac
` });
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const originalSpawn = childProcess.spawn;
  const canonicalLauncher = join(sourceRoot, 'apps/stack/bin/hstack-exec');
  childProcess.spawn = (command, args, options) => originalSpawn(
    command === canonicalLauncher ? launcher : command,
    args?.map(value => value === canonicalLauncher ? launcher : value), options,
  );
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); });
  const env = { ...buildNativeAdmissionFixtureEnv(), PATH: `${binDir}:${process.env.PATH ?? ''}`, HAPPIER_DEV_TARGET_EXECUTION: '1' };
  return { env, launcher };
}
