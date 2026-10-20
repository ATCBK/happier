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
});
