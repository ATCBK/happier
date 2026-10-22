import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStressHostObserver } from './stress-host.mjs';

test('isolated stress observation uses real container identity and physical SQL totals; unknown daemon CPU stays unavailable', async () => {
  let calls = 37;
  const observer = await createStressHostObserver({
    context: { composeProjectName: 'happier-stress-perf-test', uiDir: '/export', containers: [{ id: 'owned-api', service: 'api', image: 'sha256:actual-image' }], postgresContainerId: 'owned-postgres' },
    inspect: async () => [{ Id: 'owned-api', Image: 'sha256:actual-image', Config: { Labels: { 'com.docker.compose.project': 'happier-stress-perf-test' } }, State: { Running: true } }],
    sqlStatements: async () => calls++,
  });
  const before = await observer.sample();
  const after = await observer.sample();
  assert.equal(before.identity.roles.server.loaded, 'sha256:actual-image');
  assert.equal(before.server.cpuSeconds, null);
  assert.equal(before.daemon, null);
  assert.equal(after.sqlStatements - before.sqlStatements, 1);
  assert.equal((await observer.stop()).status, 'CLOSED');
});

test('an isolated observer refuses foreign or stopped containers instead of certifying them', async () => {
  await assert.rejects(createStressHostObserver({
    context: { composeProjectName: 'happier-stress-perf-test', uiDir: '/export', containers: [{ id: 'owned-api', service: 'api' }], postgresContainerId: 'owned-postgres' },
    inspect: async () => [{ Id: 'owned-api', Image: 'sha256:image', Config: { Labels: { 'com.docker.compose.project': 'other-project' } }, State: { Running: true } }],
    sqlStatements: async () => 0,
  }), /ownership/);
});

test('a replaced image cannot masquerade as the source selected before the measurement', async () => {
  await assert.rejects(createStressHostObserver({
    context: { composeProjectName: 'happier-stress-perf-test', uiDir: '/export', containers: [{ id: 'owned-api', image: 'sha256:selected' }], postgresContainerId: 'owned-postgres' },
    inspect: async () => [{ Id: 'owned-api', Image: 'sha256:different', Config: { Labels: { 'com.docker.compose.project': 'happier-stress-perf-test' } }, State: { Running: true } }],
    sqlStatements: async () => 0,
  }), /identity/);
});

test('an unavailable informational SQL counter is explicit, never invented zero', async () => {
  const observer = await createStressHostObserver({
    context: { composeProjectName: 'happier-stress-perf-test', uiDir: '/export', containers: [{ id: 'owned-api', image: 'sha256:image' }], postgresContainerId: 'owned-postgres' },
    inspect: async () => [{ Id: 'owned-api', Image: 'sha256:image', Config: { Labels: { 'com.docker.compose.project': 'happier-stress-perf-test' } }, State: { Running: true } }],
    sqlStatements: async () => { throw new Error('counter unavailable'); },
  });
  assert.equal((await observer.sample()).sqlStatements, null);
  assert.match((await observer.sample()).unavailable.join(' '), /SQL/);
  await observer.stop();
});
