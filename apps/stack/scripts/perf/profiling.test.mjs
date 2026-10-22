import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeMainThreadTrace, summarizeHeapProfile, evaluateSettledHome } from './profiling.mjs';
import { frameKey } from './analysis.mjs';

test('trace work is clipped to the explicit main thread/window and nested work is unioned', () => {
  const event = (name, ts, dur, extra = {}) => ({ name, ph: 'X', ts, dur, pid: 7, tid: 9, ...extra });
  const result = summarizeMainThreadTrace([
    event('RunTask', 0, 61000), event('RunTask', 10000, 30000),
    event('TimerFire', 2000, 59000), event('Layout', 11000, 20000), event('Paint', 15000, 10000),
    { name: 'MajorGC', ph: 'B', ts: 41000, pid: 7, tid: 9 },
    { name: 'MajorGC', ph: 'E', ts: 51000, pid: 7, tid: 9 },
    event('RunTask', 81000, 10000), event('EventDispatch', 81000, 10000, { args: { data: { type: 'DOMContentLoaded' } } }),
    event('RunTask', 2000, 90000, { tid: 10 }), event('RunTask', 2000, 90000, { pid: 8 }),
  ], { startUs: 1000, endUs: 101000, pid: 7, tid: 9 });
  assert.equal(result.available, true);
  assert.equal(result.durationMs, 100);
  assert.equal(result.mainThreadBusyMs, 70);
  assert.equal(result.busyFraction, .7);
  assert.equal(result.taskCount, 2);
  assert.equal(result.longTaskCount, 1);
  assert.equal(result.maxTaskMs, 60);
  assert.equal(result.styleLayoutPaintMs, 20);
  assert.equal(result.gcMs, 10);
  assert.equal(result.triggerRows.find(row => row.trigger === 'timer').ms, 60);
  assert.deepEqual(result.triggerRows.map(({ trigger, ms }) => ({ trigger, ms })),
    [{ trigger: 'timer', ms: 60 }, { trigger: 'event', ms: 10 }], 'lifecycle events must not be attributed to user input');
});

test('trace rejects missing thread/window, missing task coverage and incomplete begin/end events', () => {
  assert.equal(summarizeMainThreadTrace([], { startUs: 0, endUs: 300000000, pid: 1, tid: 1 }).available, false);
  assert.equal(summarizeMainThreadTrace([{ name: 'RunTask', ph: 'B', ts: 1, pid: 1, tid: 1 }],
    { startUs: 0, endUs: 300000000, pid: 1, tid: 1 }).available, false);
  assert.equal(summarizeMainThreadTrace([], {}).available, false);
});

test('heap walks deep profiles iteratively and projects mapped sources without query secrets', () => {
  const frame = { scriptId: '4', url: 'https://app.test/bundle.js?secret=hidden', functionName: 'allocate', lineNumber: 4, columnNumber: 2 };
  const root = { callFrame: frame, selfSize: 12, children: [] };
  let leaf = root;
  for (let index = 0; index < 12000; index++) {
    const next = { callFrame: frame, selfSize: 2, children: [] };
    leaf.children.push(next); leaf = next;
  }
  const symbols = new Map([[frameKey(frame), { source: 'https://app.test/src/owner.ts?secret=hidden', name: 'owner', line: 20 }]]);
  const result = summarizeHeapProfile({ head: root, samples: [{ size: 999999 }] }, symbols);
  assert.equal(result.sampledBytes, 24012);
  assert.equal(result.functions.length, 1);
  assert.equal(result.functions[0].selfBytes, 24012);
  assert.equal(result.functions[0].source, 'https://app.test/src/owner.ts');
  assert.equal(result.functions[0].name, 'owner');
  assert.equal(result.functions[0].line, 20);
  assert.equal(result.retainedHeapBytes, undefined);
  assert.equal(summarizeHeapProfile(null).available, false);
});

const settled = () => ({ durationMs: 300000,
  trace: { available: true, durationMs: 300000, busyFraction: .01, mainThreadBusyMs: 3000, longTaskCount: 0 },
  diagnostics: { storeNotificationsAvailable: true, storeNotifications: [{ atMs: 1, changedKeys: ['machines'] }] } });

test('settled Home assertions fail closed and apply the strict five-minute budget', () => {
  assert.equal(evaluateSettledHome(settled(), {}).status, 'PASS');
  const busy = settled(); busy.trace.busyFraction = .05;
  assert.equal(evaluateSettledHome(busy, {}).status, 'FAIL');
  const short = settled(); short.durationMs = 299999;
  assert.equal(evaluateSettledHome(short, {}).status, 'FAIL');
  const changed = settled(); changed.diagnostics.storeNotifications[0].changedKeys = [];
  assert.equal(evaluateSettledHome(changed, {}).status, 'FAIL');
  const task = settled(); task.trace.longTaskCount = 1;
  assert.equal(evaluateSettledHome(task, {}).status, 'FAIL', 'nonempty keys or socket activity do not explain a long task');
  const missing = settled(); missing.diagnostics.storeNotificationsAvailable = false;
  assert.equal(evaluateSettledHome(missing, {}).status, 'UNAVAILABLE');
  assert.equal(evaluateSettledHome({ ...settled(), trace: null }, {}).status, 'UNAVAILABLE');
  assert.equal(evaluateSettledHome({ ...settled(), trace: { ...settled().trace, dataLossOccurred: true } }, {}).status, 'UNAVAILABLE');
  assert.equal(evaluateSettledHome(settled(), {}).metrics.semanticChangesVerified, false);
});
