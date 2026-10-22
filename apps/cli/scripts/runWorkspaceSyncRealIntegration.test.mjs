import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWorkspaceSyncRealIntegrationPlan,
  runWorkspaceSyncRealIntegration,
} from './runWorkspaceSyncRealIntegration.mjs';

const binaries = Object.freeze({
  HAPPIER_MUTAGEN_LIVE_MANAGER_BIN: '/artifacts/happier-mutagen',
  HAPPIER_MUTAGEN_LIVE_AGENT_BIN: '/artifacts/happier-mutagen-agent',
  HAPPIER_MUTAGEN_BROKER_CLIENT_TEST_BIN: '/artifacts/happier-mutagen-broker-client-test',
  HAPPIER_PROCESS_CUSTODY_LIVE_BIN: '/artifacts/happier-process-custody',
});

test('requires every source-built workspace-sync binary before constructing the lane', () => {
  assert.throws(
    () => createWorkspaceSyncRealIntegrationPlan({ env: {} }),
    /workspace-sync real-lane blocked preflight: required HAPPIER_MUTAGEN_LIVE_MANAGER_BIN.*HAPPIER_MUTAGEN_LIVE_AGENT_BIN.*HAPPIER_MUTAGEN_BROKER_CLIENT_TEST_BIN.*HAPPIER_PROCESS_CUSTODY_LIVE_BIN/u,
  );
});

test('fails preflight with the owning environment name when a configured binary is unavailable', () => {
  assert.throws(
    () => runWorkspaceSyncRealIntegration({
      env: binaries,
      accessSyncImpl: (path) => {
        if (path === binaries.HAPPIER_MUTAGEN_LIVE_AGENT_BIN) {
          const error = new Error('ENOENT');
          error.code = 'ENOENT';
          throw error;
        }
      },
    }),
    /workspace-sync real-lane blocked preflight: HAPPIER_MUTAGEN_LIVE_AGENT_BIN points to an unavailable binary at \/artifacts\/happier-mutagen-agent/u,
  );
});

test('plans the relay-fixture build plus local and remote source-built workspace-sync specs', () => {
  const plan = createWorkspaceSyncRealIntegrationPlan({
    env: binaries,
    platform: 'win32',
    arch: 'x64',
    cwd: 'C:\\repo\\apps\\cli',
    irohNativeDirectory: 'C:\\repo\\packages\\iroh-native',
  });

  assert.deepEqual(plan.build, {
    args: ['--silent', 'run', 'build:native:test-relay'],
    cwd: 'C:\\repo\\packages\\iroh-native',
  });
  assert.equal(
    plan.addonPath,
    'C:\\repo\\packages\\iroh-native\\native\\happier-iroh-native-lifecycle-test.win32-x64.node',
  );
  assert.deepEqual(
    plan.tests.map((testPlan) => testPlan.args.filter((arg) => arg.endsWith('.test.ts')).at(-1)),
    [
      'src/actions/actionExecutor.sessionHandoff.test.ts',
      'src/workspaces/sync/workspaceSyncLegacySurface.architecture.test.ts',
      'src/daemon/startDaemon.handoff.integration.test.ts',
      'src/workspaces/sync/workspaceSyncTargetBootstrap.test.ts',
      'src/workspaces/sync/workspaceSyncNativeConfinedFileSystem.test.ts',
      'src/workspaces/sync/transport/workspaceSyncBroker.go.real.integration.test.ts',
      'src/daemon/startup/createDaemonWorkspaceSyncRuntime.real.integration.test.ts',
      'src/daemon/peer/iroh/workspaceMachineCarrierMutagen.real.integration.test.ts',
      'src/daemon/startup/createDaemonWorkspaceSyncRuntime.real.integration.test.ts',
    ],
  );
  assert.deepEqual(plan.tests[0].args, [
    '--silent',
    'run',
    'test:local',
    'src/actions/actionExecutor.workspaceSyncConflict.test.ts',
    'src/actions/actionExecutor.sessionHandoff.test.ts',
  ]);
  assert.match(plan.tests[0].cwd, /packages[/\\]protocol$/u);
  assert.deepEqual(plan.tests[1].args, [
    '--silent',
    'run',
    'vitest:local',
    'run',
    '-c',
    'vitest.config.ts',
    'src/workspaces/sync/workspaceSyncLegacySurface.architecture.test.ts',
  ]);
  assert.deepEqual(plan.tests[2].args, [
    '--silent',
    'run',
    'vitest:local',
    'run',
    '--isolate',
    '-c',
    'vitest.integration.config.ts',
    'src/daemon/startDaemon.handoff.integration.test.ts',
    '-t',
    'enters session.handoff through the loaded daemon and reaches relationship and target authorities',
  ]);
  assert.deepEqual(plan.tests[3].args, [
    '--silent',
    'run',
    'vitest:local',
    'run',
    '--isolate',
    '-c',
    'vitest.config.ts',
    'src/workspaces/sync/workspaceSyncTargetBootstrap.test.ts',
    '-t',
    'returns approval_stale without mutation when the approved root object was replaced|rolls back durable replacement custody when restart finds no final READY|treats exact READY plus receipt as committed cleanup pending on restart|does not trust mismatched READY to commit a retained rollback receipt',
  ]);
  assert.deepEqual(plan.tests[4].args, [
    '--silent',
    'run',
    'vitest:local',
    'run',
    '--isolate',
    '-c',
    'vitest.config.ts',
    'src/workspaces/sync/workspaceSyncNativeConfinedFileSystem.test.ts',
    '-t',
    'uses the staged native helper for read, abort preservation, and committed deletion',
  ]);
  assert.equal(plan.tests[4].env.HAPPIER_RUN_NATIVE_CONFINED_WORKSPACE_SYNC_REAL_INTEGRATION, '1');
  assert.equal(plan.tests[2].env.HAPPIER_RUN_MUTAGEN_REAL_INTEGRATION, '1');
  assert.equal(plan.tests[5].env.HAPPIER_RUN_MUTAGEN_REAL_INTEGRATION, '1');
  assert.equal(plan.tests[5].env.HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION, undefined);
  assert.equal(plan.tests[7].env.HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION, '1');
  assert.equal(plan.tests[8].env.HAPPIER_RUN_MUTAGEN_INSTALLED_ARTIFACT_INTEGRATION, '1');
  assert.equal(plan.tests[8].env.HAPPIER_MUTAGEN_LIVE_MANAGER_BIN, '');
  assert.equal(plan.tests[8].env.HAPPIER_MUTAGEN_LIVE_AGENT_BIN, '');
});

test('builds once and runs all real specs with source binaries and one stable relay addon', () => {
  const temporaryRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
  const calls = [];
  const accessed = [];
  const copied = [];
  const removed = [];
  runWorkspaceSyncRealIntegration({
    env: { ...binaries, EXISTING_VALUE: 'preserved' },
    accessSyncImpl: (path) => accessed.push(path),
    execPnpmImpl: (args, options) => calls.push({ args, options }),
    makeTempDirImpl: (prefix) => {
      assert.equal(prefix, join(temporaryRoot, 'happier-workspace-sync-real-'));
      return '/tmp/happier-workspace-sync-real-stable';
    },
    copyFileImpl: (source, destination) => copied.push({ source, destination }),
    removeDirImpl: (directory) => removed.push(directory),
  });

  assert.equal(calls.length, 10);
  assert.deepEqual(calls[0].args, ['--silent', 'run', 'build:native:test-relay']);
  assert.deepEqual(calls[1].args, [
    '--silent',
    'run',
    'test:local',
    'src/actions/actionExecutor.workspaceSyncConflict.test.ts',
    'src/actions/actionExecutor.sessionHandoff.test.ts',
  ]);
  assert.deepEqual(calls[2].args, [
    '--silent',
    'run',
    'vitest:local',
    'run',
    '-c',
    'vitest.config.ts',
    'src/workspaces/sync/workspaceSyncLegacySurface.architecture.test.ts',
  ]);
  assert.deepEqual(calls[3].args, [
    '--silent',
    'run',
    'vitest:local',
    'run',
    '--isolate',
    '-c',
    'vitest.integration.config.ts',
    'src/daemon/startDaemon.handoff.integration.test.ts',
    '-t',
    'enters session.handoff through the loaded daemon and reaches relationship and target authorities',
  ]);
  assert.deepEqual(calls[4].args, [
    '--silent',
    'run',
    'vitest:local',
    'run',
    '--isolate',
    '-c',
    'vitest.config.ts',
    'src/workspaces/sync/workspaceSyncTargetBootstrap.test.ts',
    '-t',
    'returns approval_stale without mutation when the approved root object was replaced|rolls back durable replacement custody when restart finds no final READY|treats exact READY plus receipt as committed cleanup pending on restart|does not trust mismatched READY to commit a retained rollback receipt',
  ]);
  assert.deepEqual(calls[5].args, [
    '--silent',
    'run',
    'vitest:local',
    'run',
    '--isolate',
    '-c',
    'vitest.config.ts',
    'src/workspaces/sync/workspaceSyncNativeConfinedFileSystem.test.ts',
    '-t',
    'uses the staged native helper for read, abort preservation, and committed deletion',
  ]);
  assert.deepEqual(calls[6].args, [
    '--silent',
    'run',
    'vitest:local',
    'run',
    '--isolate',
    '-c',
    'vitest.integration.config.ts',
    'src/workspaces/sync/transport/workspaceSyncBroker.go.real.integration.test.ts',
  ]);
  assert.match(calls[7].args.at(-1), /createDaemonWorkspaceSyncRuntime\.real\.integration\.test\.ts/u);
  assert.match(calls[8].args.at(-1), /workspaceMachineCarrierMutagen\.real\.integration\.test\.ts/u);
  assert.match(calls[9].args.at(-1), /createDaemonWorkspaceSyncRuntime\.real\.integration\.test\.ts/u);
  assert.equal(calls[3].options.env.EXISTING_VALUE, 'preserved');
  assert.equal(calls[3].options.env.HAPPIER_RUN_MUTAGEN_REAL_INTEGRATION, '1');
  assert.equal(
    calls[5].options.env.HAPPIER_RUN_NATIVE_CONFINED_WORKSPACE_SYNC_REAL_INTEGRATION,
    ['darwin', 'win32'].includes(process.platform) ? '1' : '0',
  );
  assert.equal(calls[8].options.env.HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION, '1');
  assert.equal(calls[9].options.env.HAPPIER_RUN_MUTAGEN_INSTALLED_ARTIFACT_INTEGRATION, '1');
  assert.equal(calls[9].options.env.HAPPIER_MUTAGEN_LIVE_MANAGER_BIN, '');
  assert.equal(calls[9].options.env.HAPPIER_MUTAGEN_LIVE_AGENT_BIN, '');
  assert.equal(
    calls[6].options.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH,
    '/tmp/happier-workspace-sync-real-stable/addon.node',
  );
  assert.equal(
    calls[7].options.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH,
    '/tmp/happier-workspace-sync-real-stable/addon.node',
  );
  assert.equal(calls[6].options.env.TMPDIR, temporaryRoot);
  assert.equal(calls[6].options.env.TMP, temporaryRoot);
  assert.equal(calls[6].options.env.TEMP, temporaryRoot);
  assert.deepEqual(accessed.slice(0, 4), Object.values(binaries));
  assert.equal(accessed.length, 5);
  assert.equal(copied.length, 1);
  assert.match(copied[0].source, /native[/\\]happier-iroh-native-lifecycle-test\.[^.]+-[^.]+\.node$/u);
  assert.equal(copied[0].destination, '/tmp/happier-workspace-sync-real-stable/addon.node');
  assert.deepEqual(removed, ['/tmp/happier-workspace-sync-real-stable']);
});
