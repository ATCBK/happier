/**
 * Just-in-time artifact custody for the ordinary Iroh node addon in composed
 * production journeys (Lane 06 real-integration lane).
 *
 * The canonical real-integration runner (`packages/iroh-native`
 * `test:home-iroh:real`) builds the ordinary `packages/iroh-native` N-API
 * addon immediately before the composed production-loader journey, but remote
 * executor workspace mirrors deliberately exclude ignored native build output
 * and may delete that artifact between the runner's build and a later
 * production child start. Composition fixtures therefore call this helper
 * immediately before every production child process that loads the addon
 * through its ordinary production resolution path.
 *
 * The build step invokes the repository canonical iroh-native command through
 * the shared binary-safe logged-process corridor and fails closed unless the
 * canonical artifact exists afterwards. Builds are cargo-incremental, so a
 * rebuild immediately after the runner's build is a cheap no-op.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { resolveIrohNodeAddonPath } from '@happier-dev/iroh-native/node';

import { repoRootDir } from '../paths';
import { pnpmCommand } from '../process/commands';
import { runLoggedCommand } from '../process/spawnProcess';

export type IrohNodeAddonBuildSpec = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
}>;

export type RunIrohNodeAddonBuild = (build: IrohNodeAddonBuildSpec) => Promise<void>;

function resolveIrohNativePackageRoot(rootDir: string = repoRootDir()): string {
  return resolve(rootDir, 'packages', 'iroh-native');
}

export function resolveProductionIrohNodeAddonBuildSpec(
  params: Readonly<{ packageRoot?: string }> = {},
): IrohNodeAddonBuildSpec {
  const packageRoot = params.packageRoot ?? resolveIrohNativePackageRoot();
  return {
    // The exact canonical ordinary-addon build command the real-integration
    // runner invokes. `runLoggedCommand` resolves this through the
    // repository's binary-safe yarn invocation owner; never spawn cargo,
    // npm, or node directly here.
    command: pnpmCommand(),
    args: ['run', '--silent', 'build:native'],
    cwd: packageRoot,
  };
}

/**
 * Ensures the ordinary production Iroh node addon exists by running the
 * canonical build unconditionally (custody must hold at the instant of the
 * caller's child spawn, so an existence check must not skip the build) and
 * verifying the canonical artifact afterwards. Returns the verified artifact
 * path resolved by the production loader's canonical owner.
 */
export async function ensureProductionIrohNodeAddon(params: Readonly<{
  /** Run directory that receives the build logs. */
  testDir: string;
  /** Overrides the `packages/iroh-native` root (test-only; defaults to the repository checkout). */
  packageRoot?: string;
  /** Overrides the process boundary (test-only; defaults to the shared `runLoggedCommand` corridor). */
  runBuild?: RunIrohNodeAddonBuild;
}>): Promise<Readonly<{ addonPath: string; build: IrohNodeAddonBuildSpec }>> {
  const build = resolveProductionIrohNodeAddonBuildSpec({ packageRoot: params.packageRoot });
  const runBuild = params.runBuild ?? (async (spec: IrohNodeAddonBuildSpec) => {
    mkdirSync(params.testDir, { recursive: true });
    await runLoggedCommand({
      command: spec.command,
      args: [...spec.args],
      cwd: spec.cwd,
      stdoutPath: resolve(params.testDir, 'iroh-native-addon-build.stdout.log'),
      stderrPath: resolve(params.testDir, 'iroh-native-addon-build.stderr.log'),
      timeoutMs: 600_000,
    });
  });

  await runBuild(build);

  // The artifact name/layout grammar is owned by the production loader in
  // `@happier-dev/iroh-native/node`; never restate it here.
  const addonPath = resolveIrohNodeAddonPath(build.cwd);
  if (!existsSync(addonPath)) {
    throw new Error(
      `Iroh native addon custody failed: the ordinary production artifact is still missing after the canonical build (${build.args.join(' ')} in ${build.cwd}; logs in ${params.testDir}): ${addonPath}`,
    );
  }
  return { addonPath, build };
}

/**
 * Production children may resolve a physical workspace package copy under
 * their own node_modules, or a symlink back to the synchronized source package.
 * Stage only the ordinary sidecar in the consumer-resolved copy. An older
 * testkit could leave a source-shadowing full copy; remove it only when its
 * exact ownership marker and known layout prove it belongs to this testkit.
 */
export function stageProductionIrohNodeAddonForConsumer(params: Readonly<{
  sourceAddonPath: string;
  consumerDir: string;
}>): string {
  const sourcePackageRoot = dirname(dirname(params.sourceAddonPath));
  const formerCopyRoot = resolve(params.consumerDir, 'node_modules', '@happier-dev', 'iroh-native');
  const ownershipMarker = resolve(formerCopyRoot, '.happier-testkit-source');
  if (existsSync(formerCopyRoot) && lstatSync(formerCopyRoot).isDirectory()) {
    const markerStat = lstatSync(ownershipMarker, { throwIfNoEntry: false });
    if (markerStat) {
      if (!markerStat.isFile()
        || readFileSync(ownershipMarker, 'utf8') !== realpathSync(sourcePackageRoot)) {
        throw new Error(`Iroh testkit package copy belongs to another source: ${formerCopyRoot}`);
      }
      const knownEntries = new Set(['package.json', 'dist', 'native', '.happier-testkit-source']);
      if (readdirSync(formerCopyRoot).some((entry) => !knownEntries.has(entry))) {
        throw new Error(`Cannot remove modified Iroh testkit package copy: ${formerCopyRoot}`);
      }
      rmSync(formerCopyRoot, { recursive: true });
    }
  }

  const requireFromConsumer = createRequire(resolve(params.consumerDir, 'package.json'));
  const nodeModulePath = requireFromConsumer.resolve('@happier-dev/iroh-native/node');
  const consumerPackageRoot = dirname(dirname(nodeModulePath));
  const consumerAddonPath = resolveIrohNodeAddonPath(consumerPackageRoot);
  if (consumerAddonPath !== params.sourceAddonPath) {
    mkdirSync(dirname(consumerAddonPath), { recursive: true });
    copyFileSync(params.sourceAddonPath, consumerAddonPath);
  }
  return consumerAddonPath;
}
