import assert from 'node:assert/strict';
import test from 'node:test';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntimeSnapshotFixture } from '../../testkit/runtime_snapshot_testkit.mjs';
import { inspectActiveRuntimeSnapshot } from '../../runtime/launch/inspectActiveRuntimeSnapshot.mjs';

import {
  resolveDevPriorRuntimeServer,
} from './priorRuntimeServer.mjs';

test('server last-green admission is independent of an unavailable CLI/plugin publication', async t => {
  const fixture = await createRuntimeSnapshotFixture(t);
  await unlink(join(fixture.snapshotDir, 'cli/package-dist/index.mjs'));
  const prior = await resolveDevPriorRuntimeServer({ stackBaseDir: fixture.stackDir,
    serverComponentName: 'happier-server-light' });
  assert.equal(prior.admitted, true, prior.detail);
  const full = await inspectActiveRuntimeSnapshot({ stackBaseDir: fixture.stackDir });
  assert.equal(full.valid, false, 'whole-stack admission still rejects its missing CLI output');
});

test('dev prior-runtime admission ignores source freshness and returns the structurally valid server launch', async () => {
  const snapshot = {
    snapshotId: 'old-but-runnable',
    sourceFingerprint: 'source-from-yesterday',
    snapshotPath: '/tmp/runtime/builds/old-but-runnable',
    manifest: {
      source: { serverComponent: 'happier-server-light' },
      components: { server: { entrypoint: 'server/happier-server' } },
    },
  };

  const result = await resolveDevPriorRuntimeServer(
    {
      stackBaseDir: '/tmp/stack',
      serverComponentName: 'happier-server-light',
    },
    {
      inspectActiveRuntimeSnapshotImpl: async () => ({ snapshot }),
    },
  );

  assert.equal(result.admitted, true);
  assert.equal(result.snapshotId, 'old-but-runnable');
  assert.equal(result.sourceFingerprint, 'source-from-yesterday');
  assert.equal(result.launchSpec.command, '/tmp/runtime/builds/old-but-runnable/server/happier-server');
});

test('dev prior-runtime admission rejects a structurally invalid or server-mismatched snapshot', async () => {
  assert.deepEqual(
    await resolveDevPriorRuntimeServer(
      { stackBaseDir: '/tmp/stack', serverComponentName: 'happier-server-light' },
      { inspectActiveRuntimeSnapshotImpl: async () => ({ snapshot: null, errors: ['missing server entrypoint'] }) },
    ),
    { admitted: false, reason: 'invalid_snapshot', detail: 'missing server entrypoint' },
  );

  const mismatch = await resolveDevPriorRuntimeServer(
    { stackBaseDir: '/tmp/stack', serverComponentName: 'happier-server-light' },
    {
      inspectActiveRuntimeSnapshotImpl: async () => ({
        snapshot: {
          snapshotPath: '/tmp/runtime/builds/full',
          manifest: {
            source: { serverComponent: 'happier-server' },
            components: { server: { entrypoint: 'server/happier-server' } },
          },
        },
      }),
    },
  );
  assert.equal(mismatch.admitted, false);
  assert.equal(mismatch.reason, 'server_component_mismatch');
});

test('dev prior-runtime admission also selects the full server last-green output', async () => {
  const result = await resolveDevPriorRuntimeServer(
    { stackBaseDir: '/tmp/stack', serverComponentName: 'happier-server' },
    {
      inspectActiveRuntimeSnapshotImpl: async () => {
        return { snapshot: { snapshotId: 'full-last-green', snapshotPath: '/tmp/runtime/full',
          manifest: { source: { serverComponent: 'happier-server' },
            components: { server: { entrypoint: 'server/happier-server' } } } } };
      },
    },
  );

  assert.equal(result.admitted, true);
  assert.equal(result.launchSpec.command, '/tmp/runtime/full/server/happier-server');
});
