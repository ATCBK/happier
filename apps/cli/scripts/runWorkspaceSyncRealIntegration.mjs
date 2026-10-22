#!/usr/bin/env node
import { accessSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execPnpm } from '../../../scripts/workspaces/execPnpmCommand.mjs';
import { resolveArtifactName } from '../../../packages/iroh-native/scripts/build-node-addon.mjs';

const cliDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultIrohNativeDirectory = resolve(cliDirectory, '../../packages/iroh-native');
const defaultProtocolDirectory = resolve(cliDirectory, '../../packages/protocol');
export const requiredWorkspaceSyncRealBinaryEnvironment = Object.freeze([
  'HAPPIER_MUTAGEN_LIVE_MANAGER_BIN',
  'HAPPIER_MUTAGEN_LIVE_AGENT_BIN',
  'HAPPIER_MUTAGEN_BROKER_CLIENT_TEST_BIN',
  'HAPPIER_PROCESS_CUSTODY_LIVE_BIN',
]);

export function createWorkspaceSyncRealIntegrationPlan({
  env = process.env,
  cwd = cliDirectory,
  platform = process.platform,
  arch = process.arch,
  irohNativeDirectory = defaultIrohNativeDirectory,
  protocolDirectory = defaultProtocolDirectory,
} = {}) {
  const missing = requiredWorkspaceSyncRealBinaryEnvironment.filter((name) => !String(env[name] ?? '').trim());
  if (missing.length > 0) {
    throw new Error(`workspace-sync real-lane blocked preflight: required ${requiredWorkspaceSyncRealBinaryEnvironment.join(', ')}; missing ${missing.join(', ')}`);
  }
  const platformPath = platform === 'win32' ? win32 : posix;
  const addonPath = platformPath.join(
    irohNativeDirectory,
    'native',
    resolveArtifactName(platform, arch, { testRelayFixture: true }),
  );
  const mutagenTestEnvironment = {
    ...env,
    HAPPIER_RUN_MUTAGEN_REAL_INTEGRATION: '1',
  };
  const createTestPlan = (
    specPath,
    testEnv = mutagenTestEnvironment,
    testName,
    config = 'vitest.integration.config.ts',
  ) => ({
    args: [
      '--silent',
      'run',
      'vitest:local',
      'run',
      '--isolate',
      '-c',
      config,
      specPath,
      ...(testName ? ['-t', testName] : []),
    ],
    cwd,
    env: testEnv,
  });
  return {
    binaryInputs: requiredWorkspaceSyncRealBinaryEnvironment.map((name) => ({
      name,
      path: resolve(String(env[name])),
    })),
    binaryPaths: requiredWorkspaceSyncRealBinaryEnvironment.map((name) => resolve(String(env[name]))),
    addonPath,
    build: {
      args: ['--silent', 'run', 'build:native:test-relay'],
      cwd: irohNativeDirectory,
    },
    tests: [
      {
        args: [
          '--silent',
          'run',
          'test:local',
          'src/actions/actionExecutor.workspaceSyncConflict.test.ts',
          'src/actions/actionExecutor.sessionHandoff.test.ts',
        ],
        cwd: protocolDirectory,
        env,
      },
      {
        args: [
          '--silent',
          'run',
          'vitest:local',
          'run',
          '-c',
          'vitest.config.ts',
          'src/workspaces/sync/workspaceSyncLegacySurface.architecture.test.ts',
        ],
        cwd,
        env,
      },
      createTestPlan(
        'src/daemon/startDaemon.handoff.integration.test.ts',
        mutagenTestEnvironment,
        'enters session.handoff through the loaded daemon and reaches relationship and target authorities',
      ),
      createTestPlan(
        'src/workspaces/sync/workspaceSyncTargetBootstrap.test.ts',
        env,
        'returns approval_stale without mutation when the approved root object was replaced|rolls back durable replacement custody when restart finds no final READY|treats exact READY plus receipt as committed cleanup pending on restart|does not trust mismatched READY to commit a retained rollback receipt',
        'vitest.config.ts',
      ),
      createTestPlan(
        'src/workspaces/sync/workspaceSyncNativeConfinedFileSystem.test.ts',
        {
          ...env,
          HAPPIER_RUN_NATIVE_CONFINED_WORKSPACE_SYNC_REAL_INTEGRATION:
            ['darwin', 'win32'].includes(platform) ? '1' : '0',
        },
        'uses the staged native helper for read, abort preservation, and committed deletion',
        'vitest.config.ts',
      ),
      createTestPlan('src/workspaces/sync/transport/workspaceSyncBroker.go.real.integration.test.ts'),
      createTestPlan('src/daemon/startup/createDaemonWorkspaceSyncRuntime.real.integration.test.ts'),
      createTestPlan(
        'src/daemon/peer/iroh/workspaceMachineCarrierMutagen.real.integration.test.ts',
        {
          ...mutagenTestEnvironment,
          HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION: '1',
        },
      ),
      createTestPlan(
        'src/daemon/startup/createDaemonWorkspaceSyncRuntime.real.integration.test.ts',
        {
          ...mutagenTestEnvironment,
          // This subpass must prove the canonical acquired artifact rather
          // than accidentally reusing the source-built manager/agent inputs
          // required by the other real-process lanes.
          HAPPIER_MUTAGEN_LIVE_MANAGER_BIN: '',
          HAPPIER_MUTAGEN_LIVE_AGENT_BIN: '',
          HAPPIER_RUN_MUTAGEN_INSTALLED_ARTIFACT_INTEGRATION: '1',
        },
      ),
    ],
  };
}

export function runWorkspaceSyncRealIntegration({
  env = process.env,
  accessSyncImpl = accessSync,
  execPnpmImpl = execPnpm,
  makeTempDirImpl = mkdtempSync,
  copyFileImpl = copyFileSync,
  removeDirImpl = rmSync,
} = {}) {
  const plan = createWorkspaceSyncRealIntegrationPlan({ env });
  for (const binary of plan.binaryInputs) {
    try {
      accessSyncImpl(binary.path);
    } catch {
      throw new Error(
        `workspace-sync real-lane blocked preflight: ${binary.name} points to an unavailable binary at ${binary.path}`,
      );
    }
  }
  execPnpmImpl(plan.build.args, {
    cwd: plan.build.cwd,
    env,
    stdio: 'inherit',
  });
  try {
    accessSyncImpl(plan.addonPath);
  } catch {
    throw new Error(
      `workspace-sync real-lane blocked preflight: the source-built Iroh relay fixture is unavailable at ${plan.addonPath}`,
    );
  }

  // The canonical remote workspace mirror excludes ignored native build
  // output. Preserve the selected source-built addon outside the mirror
  // before either child test can trigger another synchronization boundary.
  // Darwin's per-user temp prefix is long enough to collide after Unix-socket
  // path truncation. `/tmp` is the platform's canonical short alias and keeps
  // the broker endpoint distinct for each mkdtemp-owned fixture directory.
  const tempRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
  const stableDirectory = makeTempDirImpl(join(tempRoot, 'happier-workspace-sync-real-'));
  try {
    const stableAddonPath = join(stableDirectory, 'addon.node');
    copyFileImpl(plan.addonPath, stableAddonPath);
    for (const testPlan of plan.tests) {
      execPnpmImpl(testPlan.args, {
        cwd: testPlan.cwd,
        env: {
          ...testPlan.env,
          // Mutagen's local broker uses Unix-domain sockets. Keep all fixture
          // roots below the already-bounded runner directory so macOS's long
          // per-user temp prefix cannot exceed the socket path limit.
          TMPDIR: tempRoot,
          TMP: tempRoot,
          TEMP: tempRoot,
          HAPPIER_TEST_IROH_NODE_ADDON_PATH: stableAddonPath,
        },
        stdio: 'inherit',
      });
    }
  } finally {
    removeDirImpl(stableDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    runWorkspaceSyncRealIntegration();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[workspace-sync:real] ${message}\n`);
    process.exitCode = 1;
  }
}
