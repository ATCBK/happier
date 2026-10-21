import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeNetwork, summarizeProfile, summarizeLogs, compareRuns } from './analysis.mjs';

test('duplicate candidates require the same method, full request fingerprint and overlapping lifetime', () => {
  const requests = [
    { endpoint: '/items', method: 'GET', fingerprint: 'a', startMs: 0, endMs: 20, encodedBytes: 10 },
    { endpoint: '/items', method: 'GET', fingerprint: 'a', startMs: 10, endMs: 30, encodedBytes: 20 },
    { endpoint: '/items', method: 'GET', fingerprint: 'b', startMs: 12, endMs: 25, encodedBytes: 30 },
    { endpoint: '/items', method: 'GET', fingerprint: 'a', startMs: 35, endMs: 40, encodedBytes: 40 },
    { endpoint: '/items', method: 'POST', fingerprint: 'a', startMs: 12, endMs: 18, encodedBytes: 50 },
  ];
  const result = summarizeNetwork(requests);
  assert.equal(result.requests, 5);
  assert.equal(result.duplicateCandidates, 1);
  assert.equal(result.encodedBytes, 150);
  assert.equal(result.endpoints.find(row => row.method === 'GET').count, 4);
});

test('CPU samples retain script identity and recursive frames count inclusive time once', () => {
  const frame = (scriptId, url, functionName) => ({ scriptId, url, functionName, lineNumber: 0, columnNumber: 0 });
  const profile = { startTime: 0, endTime: 6000, nodes: [
    { id: 1, callFrame: frame('0', '', '(root)'), children: [2] },
    { id: 2, callFrame: frame('1', '/a.js', 'render'), children: [3] },
    { id: 3, callFrame: frame('1', '/a.js', 'render'), children: [4] },
    { id: 4, callFrame: frame('2', '/b.js', 'render') },
  ], samples: [3, 4], timeDeltas: [2000, 4000] };
  const result = summarizeProfile(profile);
  assert.equal(result.sampledMs, 6);
  assert.equal(result.functions.find(row => row.source === '/a.js').inclusiveMs, 6);
  assert.equal(result.functions.find(row => row.source === '/b.js').selfMs, 4);
});

test('server and daemon logs are windowed, query attempts correlate by request id, payloads stay out', () => {
  const lines = [
    JSON.stringify({ time: 999, module: 'web-latency', phase: 'db.Account.findMany', elapsedMs: 7, requestId: 'r' }),
    JSON.stringify({ time: 1000, module: 'web-latency', phase: 'db.Account.findMany', elapsedMs: 4, requestId: 'r', params: 'secret' }),
    JSON.stringify({ time: 1001, module: 'web-latency', phase: 'http.GET./v1/account', elapsedMs: 9, requestId: 'r' }),
    '[00:00:01.002] [CONTROL SERVER] Request completed {"requestId":"d","route":"/rpc","durationMs":2,"body":"secret"}',
  ];
  const result = summarizeLogs(lines.join('\n'), { startMs: 1000, endMs: 1003, date: '1970-01-01' });
  assert.equal(result.db.attempts, 1);
  assert.equal(result.http[0].dbAttempts, 1);
  assert.equal(result.daemon.length, 1);
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('comparison keeps cold/warm separate and withholds timing percentiles below five repeats', () => {
  const run = (cache, durationMs, requests) => ({ journey: 'J1', cache, uiMode: 'export', status: 'CAPTURED', captureMode: 'timing', instrumentation: { storeTelemetry: false, fiberHook: false }, durationMs, counts: { requests } });
  const before = Array.from({ length: 5 }, (_, i) => run('cold', i + 1, 10));
  const after = [run('cold', 2, 4), ...Array.from({ length: 5 }, () => run('warm', 3, 3))];
  const result = compareRuns(before, after);
  assert.equal(result[0].counts.requests.delta, -6);
  assert.equal(result[0].beforeTiming.p95Ms, 5);
  assert.equal(result[0].afterTiming, null);
  assert.equal(result.length, 2);
  const failed = { ...run('cold', 999, 999), status: 'FAILED', eligible: false };
  const partial = compareRuns([...before, failed], [...before, failed]);
  assert.equal(partial[0].beforeRuns, 5, 'failed journeys never enter comparison means or percentiles');
  assert.equal(partial[0].counts.requests.before, 10);
  const revised = compareRuns(before.map(run => ({ ...run, version: 2 })), before.map(run => ({ ...run, version: 3 })));
  assert.equal(revised.length, 2, 'changed collector window semantics must not pool legacy and current bundles');
  assert.ok(revised.every(row => row.counts.requests.delta === null));
});

test('network aggregation brackets starts and distinguishes failed, canceled, late and unfinished requests', () => {
  const request = (startMs, extra = {}) => ({ endpoint: 'https://qa.test/v2/sessions/active', method: 'GET', startMs, ...extra });
  const result = summarizeNetwork([
    request(99, { endMs: 110, encodedBytes: 1000 }),
    request(101, { endMs: 120, encodedBytes: 10 }),
    request(102, { endMs: 220, encodedBytes: 20 }),
    request(103, { endMs: 150, failed: true, canceled: true }),
    request(104, { endMs: 160, failed: true, canceled: false }),
    request(105), request(201, { endMs: 210, encodedBytes: 1000 }),
    { ...request(106, { endMs: 130 }), endpoint: 'https://qa.test/v2/sessions/metadata-upgrades' },
    { ...request(107, { endMs: 130 }), endpoint: 'https://qa.test/v2/sessions/01234567-89ab-cdef-0123-456789abcdef' },
  ], { startMs: 100, endMs: 200 });
  assert.equal(result.requests, 7);
  assert.deepEqual(result.dispositions, { completed: 3, failed: 1, canceled: 1, pendingAtEnd: 2, completedAfterWindow: 1 });
  assert.equal(result.encodedBytesCompletedWithinWindow, 10);
  assert.equal(result.encodedBytesObserved, 30);
  assert.equal(result.routeClasses['session-exact'], 1, 'fixed list routes must not be exact Session rows');
});
