import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { snapshotHost, processSnapshot } from './host-snapshot.mjs';
import { parseLogRecords, summarizeLogs } from './analysis.mjs';

test('host reader projects real log files in the selected window without certifying a missing runtime', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-perf-host-' });
  const root = fixture.path('agent-qa-perf');
  await mkdir(fixture.path('agent-qa-perf/logs'), { recursive: true });
  await writeFile(fixture.path('agent-qa-perf/logs/server.log'), [
    { time: 1000, module: 'web-latency', phase: 'db.Account.findMany', elapsedMs: 2, requestId: 'r', sql: 'never-save' },
    { time: 1001, module: 'web-latency', phase: 'http.GET./v1/account', elapsedMs: 5, requestId: 'r', body: 'never-save' },
    { time: 2000, module: 'web-latency', phase: 'http.GET./later', elapsedMs: 1 },
  ].map(event => JSON.stringify(event)).join('\n'));
  const snapshot = await snapshotHost({ stackBaseDir: root, stack: 'agent-qa-perf', startMs: 1000, endMs: 1100 });
  assert.equal(snapshot.logs.records.length, 2);
  assert.equal(summarizeLogs(snapshot.logs.records, { startMs: 1000, endMs: 1100 }).http[0].dbAttempts, 1);
  assert.equal(snapshot.server, null);
  assert.equal(snapshot.daemon, null);
  assert.ok(!JSON.stringify(snapshot).includes('never-save'));
  assert.ok(processSnapshot(process.pid).rssBytes > 0);
});

test('server pretty records and local daemon clocks use explicit timestamps, not capture receipt time', () => {
  const records = parseLogRecords('[server] [1970-01-01T00:00:01.000Z] [00:00:01] DEBUG: [web-latency]\n[server] [1970-01-01T00:00:01.000Z]     phase: "db.Account.findMany"\n[server] [1970-01-01T00:00:01.000Z]     requestId: "r"\n[server] [1970-01-01T00:00:01.000Z]     params: "never-save"');
  assert.equal(records[0].phase, 'db.Account.findMany');
  assert.equal(records[0].atMs, 1000);
  const daemon = parseLogRecords('[01:00:01.000] [CONTROL SERVER] Request completed {"route":"/rpc","durationMs":1}', { date: '1970-01-01', timezoneOffsetMinutes: -60 });
  assert.equal(daemon[0].atMs, 1000);
  assert.ok(!JSON.stringify(records).includes('never-save'));
});
