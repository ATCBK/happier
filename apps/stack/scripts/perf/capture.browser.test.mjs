import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { runQaBrowserWorker } from '../utils/dev_targets/qa_browser.mjs';
import { startCapture } from './capture.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';

test('counts capture retains async request issuers; timing and cleanup remain uninstrumented', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-perf-browser-' });
  const html = `<!doctype html><div data-testid="session-list-view-options-trigger">Shell</div><script>
    globalThis.__HAPPIER_SYNC_PERFORMANCE__ = { isEnabled: () => globalThis.__HAPPIER_PERF_CAPTURE_MODE__ === 'counts',
      reset() {}, markScenario() {}, flush() { return {events: []}; } };
    function defaultRuntimeFetch() { return fetch('/probe?token=never-save').then(response => response.text()); }
    function issuingOperation() { return new Promise(resolve => setTimeout(() => {
      const start = performance.now(); while (performance.now() - start < 80) {}
      performance.measure('\u200bFixture', {start, end:performance.now(), detail:{devtools:{track:'Components ⚛'}}});
      performance.clearMeasures('\u200bFixture'); resolve();
    }, 0)).then(defaultRuntimeFetch); }
    function showWelcome() { document.body.innerHTML = '<div data-testid="welcome-decision-panel">Welcome</div>'; }
  </script>`;
  const probeBody = 'never-save response é'.repeat(256);
  const server = createServer((req, res) => {
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
  for (const captureMode of ['counts', 'timing']) {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const discovery = await (await fetch(`http://127.0.0.1:${endpoint.port}/json/list`)).json();
    const pageId = discovery.find(target => target.url === page.url()).id;
    const capture = await startCapture({ cdp: `http://127.0.0.1:${endpoint.port}`, pageId, cache: 'warm', captureMode,
      profiling: captureMode === 'timing', outputDir: fixture.root });
    let cleanup;
    try {
      await capture.begin();
      await page.evaluate(() => issuingOperation());
      await page.evaluate(() => showWelcome());
      const result = await capture.finish();
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
});
