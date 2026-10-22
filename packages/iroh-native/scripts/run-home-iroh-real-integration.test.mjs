import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createHomeIrohRealIntegrationPlan,
  runHomeIrohRealIntegration,
} from './run-home-iroh-real-integration.mjs';

test('prepares the current-platform relay fixture and all real transport integration tests', () => {
  const plan = createHomeIrohRealIntegrationPlan({
    platform: 'win32',
    arch: 'x64',
    packageDir: 'C:\\repo\\packages\\iroh-native',
    serverDir: 'C:\\repo\\apps\\server',
    cliDir: 'C:\\repo\\apps\\cli',
    testsDir: 'C:\\repo\\packages\\tests',
    repoRoot: 'C:\\repo',
  });

  assert.deepEqual(plan.builds, [
    { args: ['run', '--silent', 'build'], cwd: 'C:\\repo\\packages\\iroh-native' },
    { args: ['-s', 'build:native:test-relay'], cwd: 'C:\\repo\\packages\\iroh-native' },
    { args: ['-s', 'build:native'], cwd: 'C:\\repo\\packages\\iroh-native' },
  ]);
  assert.deepEqual(plan.workspacePreparation, {
    args: ['-s', '--filter', '@happier-dev/server', 'run', 'build:shared'],
    cwd: 'C:\\repo',
  });
  assert.deepEqual(plan.cliWorkspacePreparation, {
    args: ['-s', '--filter', '@happier-dev/cli', 'run', 'build:shared', '--source-dev', 'protocol'],
    cwd: 'C:\\repo',
  });
  assert.deepEqual(plan.tests.server.args, [
    '-s',
    'vitest:local',
    'run',
    '--isolate',
    '-c',
    'vitest.integration.config.ts',
    'sources/app/iroh/homeIrohEndpoint.real.integration.test.ts',
  ]);
  assert.equal(plan.tests.server.cwd, 'C:\\repo\\apps\\server');
  assert.deepEqual(plan.tests.machine.args, [
    '-s',
    'vitest:local',
    'run',
    '--isolate',
    '-c',
    'vitest.integration.config.ts',
    'src/daemon/peer/iroh/workspaceMachineCarrierLane08.real.integration.test.ts',
  ]);
  assert.equal(plan.tests.machine.cwd, 'C:\\repo\\apps\\cli');
  assert.deepEqual(plan.tests.clientMachineDirect.args, [
    '-s',
    'test:core',
    'suites/core-e2e/machineCarrierHttp.real.integration.test.ts',
  ]);
  assert.equal(plan.tests.clientMachineDirect.cwd, 'C:\\repo\\packages\\tests');
  assert.equal(plan.tests.clientMachineDirect.env.HAPPIER_MACHINE_TRANSFER_TEST_TOPOLOGY, 'direct');
  assert.equal(plan.tests.clientMachineRelay.env.HAPPIER_MACHINE_TRANSFER_TEST_TOPOLOGY, 'relay');
  assert.equal(plan.tests.server.env.HAPPIER_IROH_REQUIRE_NODE_ADDON, '1');
  assert.equal(plan.tests.machine.env.HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION, '1');
  assert.equal(plan.tests.composed.cwd, 'C:\\repo\\packages\\tests');
  assert.deepEqual(plan.tests.composed.args.slice(0, 2), ['-s', 'test:core']);
  assert.match(plan.tests.composed.args.join(' '), /home\.iroh\.composedPersonalHome\.real\.e2e\.test\.ts/u);
  assert.equal(
    plan.tests.composed.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH,
    'C:\\repo\\packages\\iroh-native\\native-test\\happier-iroh-native-lifecycle-test.win32-x64.node',
  );
  assert.equal(
    plan.tests.machine.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH,
    'C:\\repo\\packages\\iroh-native\\native-test\\happier-iroh-native-lifecycle-test.win32-x64.node',
  );
});

test('runs fixture journeys before rebuilding the ordinary addon immediately before composed production loading', () => {
  const calls = [];
  const copied = [];
  const removed = [];
  const events = [];
  runHomeIrohRealIntegration({
    env: { EXISTING_VALUE: 'preserved' },
    execPnpmImpl: (args, options) => {
      calls.push({ args, options });
      events.push(`exec:${args[1] ?? args[0]}`);
    },
    makeTempDirImpl: () => '/tmp/happier-iroh-home-test-stable',
    copyFileImpl: (source, destination) => {
      copied.push({ source, destination });
      events.push(`copy:${destination.split('/').at(-1)}`);
    },
    removeDirImpl: (directory) => removed.push(directory),
  });

  assert.equal(calls.length, 10);
  assert.deepEqual(calls[0].args, ['run', '--silent', 'build']);
  assert.deepEqual(calls[1].args, ['-s', 'build:native:test-relay']);
  assert.match(calls[2].args.join(' '), /homeIrohEndpoint\.real\.integration\.test\.ts/u);
  assert.match(calls[3].args.join(' '), /workspaceMachineCarrierLane08\.real\.integration\.test\.ts/u);
  assert.match(calls[4].args.join(' '), /machineCarrierHttp\.real\.integration\.test\.ts/u);
  assert.match(calls[5].args.join(' '), /machineCarrierHttp\.real\.integration\.test\.ts/u);
  assert.deepEqual(calls[6].args, ['-s', '--filter', '@happier-dev/server', 'run', 'build:shared']);
  assert.deepEqual(calls[7].args, ['-s', '--filter', '@happier-dev/cli', 'run', 'build:shared', '--source-dev', 'protocol']);
  assert.deepEqual(calls[8].args, ['-s', 'build:native']);
  assert.match(calls[9].args.join(' '), /home\.iroh\.composedPersonalHome\.real\.e2e\.test\.ts/u);
  assert.equal(calls[2].options.env.EXISTING_VALUE, 'preserved');
  assert.equal(calls[2].options.env.HAPPIER_IROH_REQUIRE_NODE_ADDON, '1');
  assert.equal(calls[3].options.env.HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION, '1');
  assert.equal(calls[4].options.env.HAPPIER_RUN_MACHINE_TRANSFER_REAL_INTEGRATION, '1');
  assert.equal(calls[4].options.env.HAPPIER_MACHINE_TRANSFER_TEST_TOPOLOGY, 'direct');
  assert.equal(calls[5].options.env.HAPPIER_MACHINE_TRANSFER_TEST_TOPOLOGY, 'relay');
  assert.equal(calls[9].options.env.HAPPIER_RUN_HOME_IROH_REAL_INTEGRATION, '1');
  assert.equal(copied.length, 1);
  assert.match(copied[0].source, /native-test[/\\]happier-iroh-native-lifecycle-test\.[^.]+-[^.]+\.node$/u);
  assert.equal(copied[0].destination, '/tmp/happier-iroh-home-test-stable/relay-fixture.node');
  assert.deepEqual(events, [
    'exec:build',
    'exec:build:native:test-relay',
    'copy:relay-fixture.node',
    'exec:vitest:local',
    'exec:vitest:local',
    'exec:test:core',
    'exec:test:core',
    'exec:workspace',
    'exec:workspace',
    'exec:build:native',
    'exec:test:core',
  ]);
  assert.equal(calls[2].options.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH, copied[0].destination);
  assert.equal(calls[3].options.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH, copied[0].destination);
  assert.equal(calls[4].options.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH, copied[0].destination);
  assert.equal(calls[5].options.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH, copied[0].destination);
  assert.equal(calls[8].options.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH, undefined);
  // The composed parent test process owns the shared stock test relay through
  // the stable fixture addon; the journey strips this path from production
  // server/daemon children itself.
  assert.equal(calls[9].options.env.HAPPIER_TEST_IROH_NODE_ADDON_PATH, copied[0].destination);
  assert.deepEqual(removed, ['/tmp/happier-iroh-home-test-stable']);
});

test('Docker source journey runs Home HTTP and Socket.IO against the stock relay before transfer and composed scenarios', () => {
  const calls = [];
  runHomeIrohRealIntegration({
    dockerOnly: true,
    env: { HAPPIER_TEST_IROH_EXTERNAL_RELAY_URL: 'http://127.0.0.1:49123' },
    execPnpmImpl: (args, options) => calls.push({ args, options }),
    makeTempDirImpl: () => '/tmp/happier-iroh-docker-test-stable',
    copyFileImpl: () => {},
    removeDirImpl: () => {},
  });
  assert.equal(calls.length, 8);
  assert.match(calls[2].args.join(' '), /homeIrohEndpoint\.real\.integration\.test\.ts/u);
  assert.equal(calls[2].options.env.HAPPIER_TEST_IROH_EXTERNAL_RELAY_URL, 'http://127.0.0.1:49123');
  assert.match(calls[3].args.join(' '), /machineCarrierHttp\.real\.integration\.test\.ts/u);
  assert.equal(calls[3].options.env.HAPPIER_MACHINE_TRANSFER_TEST_TOPOLOGY, 'relay');
  assert.equal(calls[3].options.env.HAPPIER_TEST_IROH_EXTERNAL_RELAY_URL, 'http://127.0.0.1:49123');
  assert.deepEqual(calls[5].args, ['-s', '--filter', '@happier-dev/cli', 'run', 'build:shared', '--source-dev', 'protocol']);
  assert.match(calls[7].args.join(' '), /home\.iroh\.composedPersonalHome\.real\.e2e\.test\.ts/u);
  assert.equal(calls[7].options.env.HAPPIER_TEST_IROH_EXTERNAL_RELAY_URL, 'http://127.0.0.1:49123');
});
