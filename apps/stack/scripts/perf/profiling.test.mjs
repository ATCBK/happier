import assert from 'node:assert/strict';
import test from 'node:test';
import * as profiling from './profiling.mjs';
const { summarizeMainThreadTrace, summarizeHeapProfile, evaluateSettledHome, summarizeJsThreadLagSampler } = profiling;
import { frameKey } from './analysis.mjs';

test('sampler overhead subtracts only proven callback slices, preserving unrelated work and GC', () => {
  assert.equal(typeof summarizeJsThreadLagSampler, 'function', 'the trace owner must expose sampler cost separately');
  const e = (name, ts, dur, data = {}) => ({ name, ph: 'X', ts, dur, pid: 7, tid: 9, args: { data } });
  const events = [
    e('RunTask', 0, 120000), e('TimerFire', 10000, 70000),
    e('FunctionCall', 11000, 68000, { scriptId: '5', lineNumber: 120 }),
    e('MinorGC', 20000, 10000), e('MinorGC', 100000, 5000),
    e('RunTask', 200000, 60000), e('TimerFire', 200000, 60000),
    e('FunctionCall', 201000, 58000, { scriptId: '5', lineNumber: 999 }),
    e('RunTask', 300000, 10000), e('TimerFire', 300000, 10000),
    e('FunctionCall', 300100, 9000, { url: 'https://app.test/jsThreadLagTelemetry.ts', lineNumber: 90 }),
    e('TimerFire', 10000, 70000, { scriptId: '5' }),
    { ...e('TimerFire', 0, 200000), tid: 10 },
  ];
  const result = summarizeJsThreadLagSampler(events, { startUs: 0, endUs: 400000, pid: 7, tid: 9 },
    [{ scriptId: '5', startLine: 100, endLine: 200 }]);
  assert.equal(result.available, true);
  assert.equal(result.timerFireCount, 3);
  assert.equal(result.timerSliceMs, 80, 'nested/duplicate slices are unioned, not double-counted');
  assert.equal(result.gcInsideSamplerMs, 10);
  assert.equal(result.observed.mainThreadBusyMs, 190);
  assert.equal(result.withoutSamplerSlices.mainThreadBusyMs, 110);
  assert.equal(result.withoutSamplerSlices.busyFraction, .275);
  assert.equal(result.withoutSamplerSlices.longTaskCount, 1);
  assert.equal(result.withoutSamplerSlices.maxTaskMs, 60);
  assert.equal(result.withoutSamplerSlices.gcMs, 5);
  assert.equal(result.counterfactual, false, 'slice subtraction never certifies sampler-off runtime or induced GC');
});

test('sampler attribution is unavailable without proof, never inferred from a 50ms timer or shared task', () => {
  assert.equal(typeof summarizeJsThreadLagSampler, 'function', 'the trace owner must expose sampler cost separately');
  const event = (name, ts, dur, data = {}) => ({ name, ph: 'X', ts, dur, pid: 1, tid: 1, args: { data } });
  const events = [event('RunTask', 0, 100000), event('TimerFire', 0, 100000),
    event('FunctionCall', 1, 99000, { scriptId: '5', lineNumber: 900 }),
    event('FunctionCall', 2, 1000, { scriptId: '5', lineNumber: 120 })];
  const window = { startUs: 0, endUs: 200000, pid: 1, tid: 1 };
  assert.equal(summarizeJsThreadLagSampler(events, window).available, false);
  const result = summarizeJsThreadLagSampler(events, window, [{ scriptId: '5', startLine: 100, endLine: 200 }]);
  assert.equal(result.timerFireCount, 0, 'a nested sampler call does not own an unrelated outer callback');
  assert.equal(result.withoutSamplerSlices.mainThreadBusyMs, 100);
});

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
