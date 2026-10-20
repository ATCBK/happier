import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { safeUrl, requestFingerprint, summarizeNetwork, compareRuns } from './analysis.mjs';

test('timing mode never installs a fiber hook and requests disabled store telemetry across documents', async () => {
  const local = new Map(), session = new Map();
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  const context = vm.createContext({ __HAPPIER_PERF_CAPTURE_MODE__: 'timing', performance: { now: () => 1 }, PerformanceObserver: { supportedEntryTypes: [] }, localStorage: storage(local), sessionStorage: storage(session), __HAPPIER_SYNC_PERFORMANCE__: { isEnabled: () => false, reset() {}, flush() {} } });
  vm.runInContext(await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8'), context);
  assert.equal(context.__REACT_DEVTOOLS_GLOBAL_HOOK__, undefined);
  assert.equal(JSON.parse(local.get('HAPPIER_SYNC_TUNING_JSON')).syncPerformanceTelemetryEnabled, false);
  const result = context.__happierPerfProbe.collect();
  assert.equal(result.instrumentation.fiberHook, false);
  assert.equal(result.instrumentation.storeTelemetry, false);
  context.__happierPerfProbe.stop();
  const existingHook = { onCommitFiberRoot() {}, renderers: new Map() };
  const reused = vm.createContext({ __HAPPIER_PERF_CAPTURE_MODE__: 'timing', __REACT_DEVTOOLS_GLOBAL_HOOK__: existingHook, performance: { now: () => 1 }, PerformanceObserver: { supportedEntryTypes: [] }, localStorage: storage(local), sessionStorage: storage(session) });
  vm.runInContext(await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8'), reused);
  assert.equal(reused.__happierPerfProbe.collect().instrumentation.fiberHook, true, 'pre-existing instrumentation cannot be certified OFF');
  reused.__happierPerfProbe.stop();
  assert.equal(reused.__REACT_DEVTOOLS_GLOBAL_HOOK__, existingHook);
});

test('promoted fiber probe rejects unchanged children with retained PerformedWork flags and restores tuning', async () => {
  const local = new Map([['HAPPIER_SYNC_TUNING_JSON', '{"other":true}']]), session = new Map();
  const storage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  const context = vm.createContext({ performance: { now: () => 1 }, PerformanceObserver: { supportedEntryTypes: [] }, localStorage: storage(local), sessionStorage: storage(session) });
  const source = await readFile(new URL('./browser-probe.js', import.meta.url), 'utf8');
  vm.runInContext(source, context);
  const child = { tag: 0, type: function VisibleRow() {}, flags: 1 };
  const root = { current: { tag: 3, child } };
  context.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root);
  context.__happierPerfProbe.reset();
  root.current = { ...root.current };
  context.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root);
  assert.equal(context.__happierPerfProbe.collect().renders, 0);
  const alternate = { ...child, alternate: child }; child.alternate = alternate;
  root.current = { tag: 3, child: alternate };
  context.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root);
  assert.equal(context.__happierPerfProbe.collect().components.VisibleRow.renders, 1);
  // Simulate a second document using the same origin before final cleanup.
  const secondDocument = vm.createContext({ performance: { now: () => 1 }, PerformanceObserver: { supportedEntryTypes: [] }, localStorage: storage(local), sessionStorage: storage(session) });
  vm.runInContext(source, secondDocument);
  secondDocument.__happierPerfProbe.stop();
  assert.equal(local.get('HAPPIER_SYNC_TUNING_JSON'), '{"other":true}');
  assert.equal(session.size, 0);
});

test('network evidence strips query, fragment, userinfo and protocol-owned capability paths', () => {
  const projected = safeUrl('https://user:password@example.com/share/capability?key=secret#secret');
  assert.equal(projected, 'https://example.com/share/:token');
  assert.equal(safeUrl('data:text/javascript,secret'), 'data:[omitted]');
  const a = requestFingerprint({ method: 'GET', url: 'http://a/items?q=one' }, 'salt');
  const b = requestFingerprint({ method: 'GET', url: 'http://a/items?q=two' }, 'salt');
  assert.notEqual(a, b);
  assert.equal(summarizeNetwork([{ method: 'POST', endpoint: '/x', fingerprint: a, bodyUnknown: true, startMs: 0 },
    { method: 'POST', endpoint: '/x', fingerprint: a, bodyUnknown: true, startMs: 1 }]).duplicateCandidates, 0);
});

test('comparison never turns unavailable counters into zero or dev timings into production evidence', () => {
  const run = { journey: 'J13', cache: 'warm', uiMode: 'dev', durationMs: 1, counts: { requests: null } };
  const result = compareRuns(Array(5).fill(run), Array(5).fill(run));
  assert.equal(result[0].counts.requests.before, null);
  assert.equal(result[0].counts.requests.delta, null);
  assert.equal(result[0].beforeTiming, null);
});

test('timings exclude count instrumentation and never pool capture modes or legacy unknown modes', () => {
  const run = { journey: 'J1', cache: 'cold', uiMode: 'export', status: 'CAPTURED', counts: {}, durationMs: 10 };
  const counts = Array(5).fill({ ...run, captureMode: 'counts', instrumentation: { storeTelemetry: true, fiberHook: true } });
  const timing = Array(5).fill({ ...run, captureMode: 'timing', instrumentation: { storeTelemetry: false, fiberHook: false } });
  const result = compareRuns([...counts, ...timing], [...counts, ...timing]);
  assert.equal(result.length, 2);
  assert.equal(result.find(row => row.captureMode === 'counts').beforeTiming, null);
  assert.equal(result.find(row => row.captureMode === 'timing').beforeTiming.p50Ms, 10);
  assert.equal(compareRuns(Array(5).fill(run), Array(5).fill(run))[0].beforeTiming, null);
});
