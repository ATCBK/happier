import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import { beginPendingSourceStart } from './pending_source_start.mjs';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { runNodeCapture } from '../../testkit/core/run_node_capture.mjs';
import { withJsonOwnerFileLock } from '../../utils/proc/jsonOwnerFileLock.mjs';

test('a delegated process shares its parent start without superseding or retiring it', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-delegated-', registerCleanup: false });
  const parent = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  let successor;
  t.after(async () => { await parent.dispose(); await successor?.dispose(); await fixture.cleanup(); });
  await parent.retainPreparation(fixture.path('prepared'));
  const markerPath = fixture.path('source-runtime/start.pending.json');
  const markerBefore = JSON.parse(await readFile(markerPath, 'utf8'));
  const moduleUrl = new URL('./pending_source_start.mjs', import.meta.url).href;
  const delegated = await runNodeCapture(['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { beginPendingSourceStart } from ${JSON.stringify(moduleUrl)};
    const start = await beginPendingSourceStart({ stackBaseDir: ${JSON.stringify(fixture.root)},
      requestId: ${JSON.stringify(parent.requestId)} });
    try {
      assert.equal(start.requestId, ${JSON.stringify(parent.requestId)});
      await start.publish(async () => {});
    } finally { await start.dispose(); }
  `]);
  assert.equal(delegated.code, 0, delegated.stderr);
  assert.deepEqual(JSON.parse(await readFile(markerPath, 'utf8')), markerBefore,
    'delegated publication and cleanup retain the parent marker and preparation');
  await parent.publishPreparation(async () => writeFile(fixture.path('adopted'), 'yes'));
  assert.equal(parent.signal.aborted, false);
  successor = await beginPendingSourceStart({ stackBaseDir: fixture.root, requestId: 'next-parent', replacePending: true });
  await assert.rejects(beginPendingSourceStart({ stackBaseDir: fixture.root, requestId: parent.requestId }),
    { code: 'ESOURCESTARTSUPERSEDED' }, 'a stale delegated half cannot overwrite a genuine successor');
  await assert.rejects(parent.publish(async () => {}), { code: 'ESOURCESTARTSUPERSEDED' });
  await successor.publish(async () => {});
});

test('a newer process cancels only its stack pending start and prevents stale publication', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-start-', registerCleanup: false });
  const first = await beginPendingSourceStart({ stackBaseDir: fixture.path('same-stack') });
  const other = await beginPendingSourceStart({ stackBaseDir: fixture.path('other-stack') });
  const lockPath = fixture.path('shared-bundle.lock');
  let releaseBuild;
  let buildEntered;
  const buildReady = new Promise(resolve => { buildEntered = resolve; });
  const buildHeld = new Promise(resolve => { releaseBuild = resolve; });
  const build = withJsonOwnerFileLock(async () => { buildEntered(); await buildHeld; }, { lockPath });
  await buildReady;
  let waiterEntered;
  const waiterReady = new Promise(resolve => { waiterEntered = resolve; });
  const waiting = withJsonOwnerFileLock(async () => 'acquired', {
    lockPath, signal: first.signal, onWait: waiterEntered,
  }).then(value => value, error => error.name);
  t.after(async () => {
    releaseBuild();
    await Promise.allSettled([build, waiting]);
    await first.dispose();
    await other.dispose();
    await fixture.cleanup();
  });
  await waiterReady;
  const moduleUrl = new URL('./pending_source_start.mjs', import.meta.url).href;
  const replacement = await runNodeCapture(['--input-type=module', '-e', `
    import { beginPendingSourceStart } from ${JSON.stringify(moduleUrl)};
    const start = await beginPendingSourceStart({ stackBaseDir: ${JSON.stringify(fixture.path('same-stack'))} });
    await start.publish(async () => {});
    await start.dispose();
  `]);
  assert.equal(replacement.code, 0, replacement.stderr);
  const abortObserved = first.signal.aborted || await Promise.race([
    new Promise(resolve => first.signal.addEventListener('abort', () => resolve(true), { once: true })),
    delay(1_000).then(() => false),
  ]);
  assert.equal(abortObserved, true, 'the earlier stack start must self-cancel');
  assert.equal(await waiting, 'AbortError', 'the superseded start leaves its pre-build wait');
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid, 'the shared builder keeps ownership');
  assert.equal(other.signal.aborted, false, 'a different stack remains pending');
  let stalePublished = false;
  await assert.rejects(first.publish(async () => { stalePublished = true; }), { code: 'ESOURCESTARTSUPERSEDED' });
  await assert.rejects(first.publishPreparation(async () => { stalePublished = true; }), { code: 'ESOURCESTARTSUPERSEDED' });
  await assert.rejects(first.setPhase({ phase: 'building', component: 'daemon' }), { code: 'ESOURCESTARTSUPERSEDED' });
  assert.equal(stalePublished, false);
  await other.retainPreparation(fixture.path('other-preparation'));
  await other.setPhase({ phase: 'building', component: 'server' }, 'server-host');
  await other.setPhase({ phase: 'queued', component: 'daemon' }, 'daemon-host');
  await other.publishPreparation(async () => writeFile(fixture.path('other-prepared'), 'ready'));
  await other.retainPreparation(fixture.path('other-ui'));
  const retained = JSON.parse(await readFile(fixture.path('other-stack/source-runtime/start.pending.json'), 'utf8'));
  assert.deepEqual(retained.preparationDirs, [fixture.path('other-preparation'), fixture.path('other-ui')]);
  assert.deepEqual(retained.targets, { 'server-host': { phase: 'building', component: 'server' },
    'daemon-host': { phase: 'queued', component: 'daemon' } });
  assert.equal(retained.preparationDir, fixture.path('other-preparation'),
    'older loaded retainers keep the primary reload graph while a web product is pinned separately');
  await other.publish(async () => writeFile(fixture.path('other-published'), 'yes'));
  assert.equal(await readFile(fixture.path('other-published'), 'utf8'), 'yes');
});

test('completed starts stop observing successors and old cleanup preserves the current pending start', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-start-retire-', registerCleanup: false });
  const first = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  await first.publish(async () => {});
  const second = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  t.after(async () => { await first.dispose(); await second.dispose(); await fixture.cleanup(); });
  await first.dispose();
  await second.publish(async () => writeFile(fixture.path('current-published'), 'yes'));
  assert.equal(first.signal.aborted, false, 'an active start must not be cancelled');
  assert.equal(await readFile(fixture.path('current-published'), 'utf8'), 'yes');
});

test('publication checks the marker even before a supersession event is observed', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-pending-source-start-publish-', registerCleanup: false });
  const first = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  const current = await beginPendingSourceStart({ stackBaseDir: fixture.root });
  t.after(async () => { await first.dispose(); await current.dispose(); await fixture.cleanup(); });
  let published = false;
  await assert.rejects(first.publish(async () => { published = true; }), { code: 'ESOURCESTARTSUPERSEDED' });
  assert.equal(published, false);
  await first.dispose();
  await current.publish(async () => writeFile(fixture.path('selected'), 'current'));
  assert.equal(await readFile(fixture.path('selected'), 'utf8'), 'current');
});
