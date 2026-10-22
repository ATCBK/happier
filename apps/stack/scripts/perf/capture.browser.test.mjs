import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runQaBrowserWorker } from '../utils/dev_targets/qa_browser.mjs';
import { startCapture } from './capture.mjs';

test('counts capture retains async request issuers; timing and cleanup remain uninstrumented', async t => {
  const html = `<!doctype html><div data-testid="session-list-view-options-trigger">Shell</div><script>
    globalThis.__HAPPIER_SYNC_PERFORMANCE__ = { isEnabled: () => globalThis.__HAPPIER_PERF_CAPTURE_MODE__ === 'counts',
      reset() {}, markScenario() {}, flush() { return {events: []}; } };
    function defaultRuntimeFetch() { return fetch('/probe?token=never-save').then(response => response.text()); }
    function issuingOperation() { return new Promise(resolve => setTimeout(resolve, 0)).then(defaultRuntimeFetch); }
    function showWelcome() { document.body.innerHTML = '<div data-testid="welcome-decision-panel">Welcome</div>'; }
  </script>`;
  const server = createServer((req, res) => {
    res.setHeader('content-type', req.url.startsWith('/probe') ? 'text/plain' : 'text/html');
    res.end(req.url.startsWith('/probe') ? 'never-save response' : html);
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
    const capture = await startCapture({ cdp: `http://127.0.0.1:${endpoint.port}`, pageId, cache: 'warm', captureMode });
    let cleanup;
    try {
      await capture.begin();
      await page.evaluate(() => issuingOperation());
      await page.evaluate(() => showWelcome());
      const result = await capture.finish();
      const request = result.network.records.find(row => row.endpoint.endsWith('/probe'));
      assert.ok(request, 'fixture request must enter the native capture window');
      assert.equal(request.initiator.stack.some(frame => frame.functionName === 'issuingOperation'), captureMode === 'counts',
        'the Promise scheduler must be retained only with async stack tracing ON');
      assert.equal(result.react.instrumentation.asyncCallStackDepth > 0, captureMode === 'counts');
      assert.equal(result.authState.begin.surface, 'shell');
      assert.equal(result.authState.end.surface, 'welcome');
      assert.equal(result.authState.end.authenticated, null, 'DOM state cannot certify credential authority');
      assert.equal(result.authState.end.retirementReasonCode, null, 'never infer a sign-out reason');
      assert.ok(!JSON.stringify(result).includes('never-save'), 'query, response and arbitrary page text stay excluded');
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
