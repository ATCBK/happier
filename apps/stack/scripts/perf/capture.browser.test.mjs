import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { runQaBrowserWorker } from '../utils/dev_targets/qa_browser.mjs';
import { startCapture } from './capture.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { createStressHostObserver } from './stress-host.mjs';
import { runPerformanceCli } from './perf.mjs';

test('counts capture retains async request issuers; timing and cleanup remain uninstrumented', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-perf-browser-' });
  // Both real owners run in Chrome. Only the Metro registry is a bundler
  // fixture boundary; enablement, sampling and callback locations stay real.
  const telemetrySource = stripTypeScriptTypes(await readFile(new URL('../../../ui/sources/sync/runtime/syncPerformanceTelemetry.ts', import.meta.url), 'utf8'))
    .replace(/^export /gm, '');
  const telemetryBundle = `(() => { ${telemetrySource}
    globalThis.fixtureTelemetry = syncPerformanceTelemetry;
    installSyncPerformanceTelemetryGlobal(syncPerformanceTelemetry);
  })();`;
  const samplerSource = stripTypeScriptTypes(await readFile(new URL('../../../ui/sources/sync/runtime/performance/jsThreadLagTelemetry.ts', import.meta.url), 'utf8'))
    .replace('export function createJsThreadLagTelemetry', 'function createJsThreadLagTelemetry');
  const samplerBundle = `globalThis.fixtureFactory = function(global) { ${samplerSource}
    global.fixtureLag = createJsThreadLagTelemetry({telemetry:global.fixtureTelemetry});
  }; globalThis.__r = {getModules: () => new Map([[1, {isInitialized:true,
    verboseName:'apps/ui/sources/sync/runtime/performance/jsThreadLagTelemetry.ts',factory:fixtureFactory}]])};
  fixtureFactory(globalThis);`;
  const html = `<!doctype html><div data-testid="session-list-view-options-trigger">Shell</div><script>
    function defaultRuntimeFetch() { return fetch('/probe?token=never-save').then(response => response.text()); }
    function issuingOperation() { return new Promise(resolve => setTimeout(() => {
      const start = performance.now(); while (performance.now() - start < 80) {}
      performance.measure('\u200bFixture', {start, end:performance.now(), detail:{devtools:{track:'Components ⚛'}}});
      performance.clearMeasures('\u200bFixture'); resolve();
    }, 0)).then(defaultRuntimeFetch); }
    function showWelcome() { document.body.innerHTML = '<div data-testid="welcome-decision-panel">Welcome</div>'; }
  </script><script src="/telemetry-fixture.js"></script><script src="/metro-fixture.bundle"></script>`;
  const probeBody = 'never-save response é'.repeat(256);
  const server = createServer((req, res) => {
    if (req.url === '/telemetry-fixture.js') {
      res.setHeader('content-type', 'application/javascript'); res.end(telemetryBundle); return;
    }
    if (req.url === '/metro-fixture.bundle') {
      res.setHeader('content-type', 'application/javascript'); res.end(samplerBundle); return;
    }
    res.setHeader('content-type', req.url.startsWith('/probe') ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8');
    if (req.url.startsWith('/probe')) {
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('cache-control', 'no-store');
      res.end(gzipSync(probeBody));
    } else res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const input = new PassThrough(), signalSource = new EventEmitter();
  let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  const worker = runQaBrowserWorker({ sessionName: `perf-async-${process.pid}`, input, writeReady: ready }, { signalSource });
  let browser, context;
  t.after(async () => {
    try { await context?.close(); await browser?.close(); }
    finally { input.write('close\n'); try { await worker; } finally { input.destroy(); } }
  });
  const endpoint = await Promise.race([readyPromise, worker.then(() => { throw new Error('Fixture browser closed before readiness'); })]);
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const { chromium } = createRequire(`${repoDir}/packages/tests/package.json`)('@playwright/test');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.port}`, { timeout: 0 });
  context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const ordinary = await page.evaluate(() => {
    fixtureTelemetry.configure({ enabled: true });
    const started = fixtureLag.start(), duplicate = fixtureLag.start(), running = fixtureLag.isRunning();
    fixtureLag.stop();
    return { started, duplicate, running, stopped: !fixtureLag.isRunning() };
  });
  assert.deepEqual(ordinary, { started: true, duplicate: false, running: true, stopped: true },
    'ordinary telemetry outside a capture retains its sampler lifecycle');
  for (const { captureMode, cpuProfile } of [
    { captureMode: 'counts', cpuProfile: true },
    { captureMode: 'timing', cpuProfile: true },
    { captureMode: 'counts', cpuProfile: false },
  ]) {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const discovery = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json();
    const pageId = discovery.find(target => target.url === page.url()).id;
    const capture = await startCapture({ cdp: `http://127.0.0.1:${endpoint.port}`, pageId, cache: 'warm', captureMode,
      profiling: true, cpuProfile, outputDir: fixture.root });
    let cleanup;
    try {
      // The telemetry constructor reads the pre-document capture override,
      // exactly as journey preparation reloads the real app before measuring.
      await page.reload();
      await capture.begin();
      const admission = await page.evaluate(async () => {
        const started = fixtureLag.start();
        fixtureTelemetry.count('fixture.counts-preserved');
        fixtureTelemetry.registerStorageNotificationSource();
        fixtureTelemetry.recordStoreNotification({ machines: 1 }, { machines: 0 });
        await new Promise(resolve => setTimeout(resolve, 180));
        return { started, running: fixtureLag.isRunning(), counts: fixtureTelemetry.isEnabled() };
      });
      assert.equal(admission.counts, captureMode === 'counts', 'disabling the sampler must not disable counts telemetry');
      assert.equal(admission.started, false, 'capture modes must not admit the lag sampler');
      assert.equal(admission.running, false);
      await page.evaluate(() => issuingOperation());
      await page.evaluate(() => showWelcome());
      const result = await capture.finish();
      if (!cpuProfile) {
        assert.equal(result.profile, null, 'timeline-only counts must not collect or attribute a CPU profile');
        assert.equal(result.cpu, null);
        const events = JSON.parse(gunzipSync(await readFile(fixture.path('trace.json.gz')))).traceEvents;
        const timer = events.find(event => event.name === 'TimerInstall'
          && event.args?.data?.stackTrace?.some(frame => frame.functionName === 'issuingOperation'));
        assert.equal(timer?.args.data.singleShot, true, 'timer classification must survive the safe trace projection');
        assert.ok(Number.isFinite(timer.args.data.timeout));
      }
      assert.equal(result.profiling.trace.categories.includes('disabled-by-default-v8.cpu_profiler'), cpuProfile,
        'timeline-only counts must not enable the trace CPU sampler either');
      assert.equal(result.profiling.trace.categories.includes('disabled-by-default-devtools.timeline.stack'), captureMode === 'counts',
        'timer issuer stacks belong to counts, not uninstrumented timing');
      const request = result.network.records.find(row => row.endpoint.endsWith('/probe'));
      assert.ok(request, 'fixture request must enter the native capture window');
      assert.equal(request.decodedBytes, Buffer.byteLength(probeBody), 'real Chrome reports decoded UTF-8 byte length for compressed responses');
      assert.ok(request.encodedBytes < request.decodedBytes, 'actual compressed transfer remains distinct from decoded payload bytes');
      assert.equal(request.initiator.stack.some(frame => frame.functionName === 'issuingOperation'), captureMode === 'counts',
        'the Promise scheduler must be retained only with async stack tracing ON');
      assert.equal(result.react.instrumentation.asyncCallStackDepth > 0, captureMode === 'counts');
      assert.equal(result.authState.begin.surface, 'shell');
      assert.equal(result.authState.end.surface, 'welcome');
      assert.equal(result.authState.end.authenticated, null, 'DOM state cannot certify credential authority');
      assert.equal(result.authState.end.retirementReasonCode, null, 'never infer a sign-out reason');
      assert.ok(!JSON.stringify(result).includes('never-save'), 'query, response and arbitrary page text stay excluded');
      const sampler = result.profiling.trace.instrumentation.jsThreadLagSampler;
      assert.equal(sampler.available, true, 'loaded Metro factory locations must prove timer ownership');
      assert.equal(sampler.timerFireCount, 0, 'counts must retain attribution without admitting sampler timers');
      assert.equal(sampler.timerSliceMs, 0);
      assert.equal(result.react.diagnostics.storeNotifications.length, 1, 'the real root-notification tap remains active');
      assert.deepEqual(result.react.diagnostics.storeNotifications[0].changedKeys, ['machines']);
      assert.equal(result.telemetry.some(summary => summary.events.some(event => event.name === 'fixture.counts-preserved')), captureMode === 'counts');
      assert.equal(sampler.counterfactual, false);
      assert.ok(sampler.withoutSamplerSlices.mainThreadBusyMs <= sampler.observed.mainThreadBusyMs);
      if (captureMode === 'timing') {
        assert.equal(result.profiling.trace.dataLossOccurred, false);
        assert.equal(result.profiling.trace.summary.available, true);
        assert.ok(result.profiling.trace.summary.mainThreadBusyMs > 0);
        assert.equal(result.profiling.heap.summary.available, true);
        assert.ok(result.react.diagnostics.reactMeasures.some(entry => entry.name === '\u200bFixture'), `observer retains a measure cleared before collection: ${JSON.stringify(result.react.diagnostics)}`);
        assert.equal(result.react.instrumentation.fiberHook, false);
      }
    } finally {
      cleanup = await capture.close({ attestOff: true });
    }
    assert.equal(cleanup.status, 'CLEANED');
    assert.equal(cleanup.asyncCallStackDepth, 0);
    assert.equal(cleanup.authState.surface, 'welcome');
    assert.equal(cleanup.freshDocumentOffAttestation.storeTelemetry, false);
    assert.equal(cleanup.freshDocumentOffAttestation.fiberHook, false);
    assert.equal(cleanup.freshDocumentOffAttestation.authState.surface, 'shell');
  }
  const discovery = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json();
  const pageId = discovery.find(target => target.url === page.url()).id;
  const aborted = await startCapture({ cdp: `http://127.0.0.1:${endpoint.port}`, pageId, cache: 'warm', captureMode: 'counts' });
  await page.evaluate(() => { document.body.innerHTML = ''; });
  await aborted.begin();
  const cleanup = await aborted.close({ attestOff: true });
  assert.equal(cleanup.authState.surface, 'unknown', 'absence of a marker must not be called welcome or authenticated');
  assert.equal(cleanup.asyncCallStackDepth, 0, 'abort without finish must disable async tracing too');
  assert.equal(cleanup.freshDocumentOffAttestation.storeTelemetry, false);
  assert.equal(cleanup.freshDocumentOffAttestation.fiberHook, false);

  const sql = (calls, statsReset = 'stable') => ({ calls, statsReset, dealloc: 0 });
  for (const scenario of [
    { id: 'outer-unavailable', samples: [null, null, sql(10), sql(13), sql(20)], expected: 3 },
    { id: 'window-unavailable', samples: [sql(0), sql(3), null, sql(13), sql(20)], expected: null },
    { id: 'window-reset', samples: [sql(0), sql(3), sql(10), sql(13, 'reset'), sql(20, 'reset')], expected: null },
    { id: 'window-eviction', samples: [sql(0), sql(3), sql(10), { ...sql(13), dealloc: 1 }, { ...sql(20), dealloc: 1 }], expected: null },
    { id: 'window-decrease', samples: [sql(0), sql(3), sql(10), sql(2), sql(4)], expected: null },
    { id: 'valid-zero', samples: Array.from({ length: 5 }, () => sql(0)), expected: 0 },
  ]) await t.test(`optional SQL: ${scenario.id}`, async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const output = fixture.path(scenario.id), previousExitCode = process.exitCode;
    let sampleIndex = 0;
    try {
      await runPerformanceCli(['journey', scenario.id, '--session=PROF-SQL-fixture', '--cache=warm', '--ui-mode=export',
        '--capture-mode=timing', `--cdp=http://127.0.0.1:${endpoint.port}`, `--page-id=${pageId}`, `--url=${page.url()}`,
        '--home-selector=[data-testid="session-list-view-options-trigger"]', `--out=${output}`], {
        definition: { id: scenario.id, intent: 'Optional SQL evidence must not erase browser capture', steps: [{ op: 'idle', ms: 10 }] },
        startHostObserver: () => createStressHostObserver({
          context: { composeProjectName: 'happier-stress-perf-test', uiDir: fixture.root,
            containers: [{ id: 'owned-api', image: 'sha256:fixture' }], postgresContainerId: 'owned-postgres' },
          // Docker inspection and psql are OS/database boundaries. Both the
          // observer and journey/collector beneath them remain real.
          inspect: async () => [{ Id: 'owned-api', Image: 'sha256:fixture',
            Config: { Labels: { 'com.docker.compose.project': 'happier-stress-perf-test' } }, State: { Running: true } }],
          sqlStatements: async () => {
            const value = scenario.samples[Math.min(sampleIndex++, scenario.samples.length - 1)];
            if (value === null) throw new Error('private SQL failure diagnostic');
            return value;
          },
        }),
      });
    } finally { process.exitCode = previousExitCode; }
    const bundle = JSON.parse(await readFile(`${output}/bundle.json`, 'utf8'));
    assert.notEqual(bundle.status, 'FAILED', 'unavailable/reset informational SQL must not discard the capture');
    assert.equal(bundle.counts.sqlStatements, scenario.expected);
    assert.equal(bundle.gaps.some(reason => /SQL/.test(reason)), scenario.expected === null);
    assert.ok(!JSON.stringify(bundle).includes('private SQL failure diagnostic'));
    assert.ok(JSON.parse(await readFile(`${output}/cpu.cpuprofile`, 'utf8')).nodes.length > 0,
      'optional SQL gaps must retain the actual CPU-profile artifact');
    assert.equal(JSON.parse(await readFile(`${output}/host-observer.json`, 'utf8')).status, 'CLOSED');
    assert.equal(JSON.parse(await readFile(`${output}/cleanup.json`, 'utf8')).status, 'CLEANED');
  });
});
