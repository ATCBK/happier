#!/usr/bin/env node
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execPnpm } from '../../../scripts/workspaces/execPnpmCommand.mjs';
import { resolveArtifactName } from './build-node-addon.mjs';

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = resolve(packageDir, '../../apps/server');
const cliDir = resolve(packageDir, '../../apps/cli');
const testsDir = resolve(packageDir, '../tests');
const repoRoot = resolve(packageDir, '../..');

export function createHomeIrohRealIntegrationPlan({
  platform = process.platform,
  arch = process.arch,
  packageDir: selectedPackageDir = packageDir,
  serverDir: selectedServerDir = serverDir,
  cliDir: selectedCliDir = cliDir,
  testsDir: selectedTestsDir = testsDir,
  repoRoot: selectedRepoRoot = repoRoot,
} = {}) {
  const platformPath = platform === 'win32' ? win32 : posix;
  const addonPath = platformPath.join(
    selectedPackageDir,
    'native-test',
    resolveArtifactName(platform, arch, { testRelayFixture: true }),
  );
  return {
    builds: [
      { args: ['run', '--silent', 'build'], cwd: selectedPackageDir },
      { args: ['-s', 'build:native:test-relay'], cwd: selectedPackageDir },
      // The production-composed process journey must load the ordinary addon
      // through the package's production loader, not the relay-fixture addon.
      { args: ['-s', 'build:native'], cwd: selectedPackageDir },
    ],
    // The spawned Personal Home starts before the daemon, so prepare the
    // server's current workspace-package outputs here. In particular this
    // rebuilds the protocol exports from current source instead of consuming
    // a stale dist tree or a frozen/archive representation.
    workspacePreparation: {
      args: ['-s', '--filter', '@happier-dev/server', 'run', 'build:shared'],
      cwd: selectedRepoRoot,
    },
    // A source-launched daemon resolves the CLI's bundled physical workspace
    // packages. Publish the current Protocol build to that runtime copy before
    // the composed child starts; the server build only prepares its own closure.
    cliWorkspacePreparation: {
      args: ['-s', '--filter', '@happier-dev/cli', 'run', 'build:shared', '--source-dev', 'protocol'],
      cwd: selectedRepoRoot,
    },
    tests: {
      server: {
        args: [
          '-s',
          'vitest:local',
          'run',
          '--isolate',
          '-c',
          'vitest.integration.config.ts',
          'sources/app/iroh/homeIrohEndpoint.real.integration.test.ts',
        ],
        cwd: selectedServerDir,
        env: {
          HAPPIER_IROH_REQUIRE_NODE_ADDON: '1',
          HAPPIER_TEST_IROH_NODE_ADDON_PATH: addonPath,
        },
      },
      machine: {
        args: [
          '-s',
          'vitest:local',
          'run',
          '--isolate',
          '-c',
          'vitest.integration.config.ts',
          'src/daemon/peer/iroh/workspaceMachineCarrierLane08.real.integration.test.ts',
        ],
        cwd: selectedCliDir,
        env: {
          HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION: '1',
          HAPPIER_TEST_IROH_NODE_ADDON_PATH: addonPath,
        },
      },
      clientMachineDirect: {
        args: [
          '-s',
          'test:core',
          'suites/core-e2e/machineCarrierHttp.real.integration.test.ts',
        ],
        cwd: selectedTestsDir,
        env: {
          HAPPIER_RUN_MACHINE_TRANSFER_REAL_INTEGRATION: '1',
          HAPPIER_MACHINE_TRANSFER_TEST_TOPOLOGY: 'direct',
          HAPPIER_TEST_IROH_NODE_ADDON_PATH: addonPath,
        },
      },
      clientMachineRelay: {
        args: [
          '-s',
          'test:core',
          'suites/core-e2e/machineCarrierHttp.real.integration.test.ts',
        ],
        cwd: selectedTestsDir,
        env: {
          HAPPIER_RUN_MACHINE_TRANSFER_REAL_INTEGRATION: '1',
          HAPPIER_MACHINE_TRANSFER_TEST_TOPOLOGY: 'relay',
          HAPPIER_TEST_IROH_NODE_ADDON_PATH: addonPath,
        },
      },
      composed: {
        args: [
          '-s',
          'test:core',
          'suites/core-e2e/home.iroh.composedPersonalHome.real.e2e.test.ts',
        ],
        cwd: selectedTestsDir,
        env: {
          HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION: '1',
          // The composed journey's *parent test process* owns the one shared
          // stock test relay through the canonical Iroh test controller, so it
          // needs the stable fixture addon. The journey strips this path from
          // every production server/daemon child env; those children load the
          // ordinary addon through the package's production loader only.
          HAPPIER_TEST_IROH_NODE_ADDON_PATH: addonPath,
        },
      },
    },
  };
}

export function runHomeIrohRealIntegration({
  execPnpmImpl = execPnpm,
  env = process.env,
  makeTempDirImpl = mkdtempSync,
  copyFileImpl = copyFileSync,
  removeDirImpl = rmSync,
  dockerOnly = false,
} = {}) {
  const plan = createHomeIrohRealIntegrationPlan();
  // Remote workspace synchronization deliberately excludes ignored native
  // build output, so preserve the relay fixture outside that mirror. The
  // ordinary addon is rebuilt only after every fixture journey has consumed
  // this copy, immediately before the production-loader composed journey.
  const stableDir = makeTempDirImpl(join(tmpdir(), 'happier-iroh-home-test-'));
  try {
    const stableRelayFixtureAddonPath = join(stableDir, 'relay-fixture.node');
    for (const build of plan.builds.slice(0, 2)) {
      execPnpmImpl(build.args, {
        cwd: build.cwd,
        env,
        stdio: 'inherit',
      });
      if (build.args.includes('build:native:test-relay')) {
        copyFileImpl(
          plan.tests.server.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH,
          stableRelayFixtureAddonPath,
        );
      }
    }
    const testsBeforeOrdinary = dockerOnly
      ? [plan.tests.server, plan.tests.clientMachineRelay]
      : [
          plan.tests.server,
          plan.tests.machine,
          plan.tests.clientMachineDirect,
          plan.tests.clientMachineRelay,
        ];
    for (const testPlan of testsBeforeOrdinary) {
      execPnpmImpl(testPlan.args, {
        cwd: testPlan.cwd,
        env: {
          ...env,
          ...testPlan.env,
          HAPPIER_TEST_IROH_NODE_ADDON_PATH: stableRelayFixtureAddonPath,
        },
        stdio: 'inherit',
      });
    }
    execPnpmImpl(plan.workspacePreparation.args, {
      cwd: plan.workspacePreparation.cwd,
      env,
      stdio: 'inherit',
    });
    execPnpmImpl(plan.cliWorkspacePreparation.args, {
      cwd: plan.cliWorkspacePreparation.cwd,
      env,
      stdio: 'inherit',
    });
    const ordinaryBuild = plan.builds[2];
    if (!ordinaryBuild) throw new Error('Missing ordinary native addon build step.');
    execPnpmImpl(ordinaryBuild.args, {
      cwd: ordinaryBuild.cwd,
      env,
      stdio: 'inherit',
    });
    execPnpmImpl(plan.tests.composed.args, {
      cwd: plan.tests.composed.cwd,
      env: {
        ...env,
        ...plan.tests.composed.env,
        // Preserve the fixture addon outside the workspace mirror for the
        // composed parent process too (same relay-fixture custody as above).
        HAPPIER_TEST_IROH_NODE_ADDON_PATH: stableRelayFixtureAddonPath,
      },
      stdio: 'inherit',
    });
  } finally {
    removeDirImpl(stableDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runHomeIrohRealIntegration();
}
