import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createTempFixture } from '../../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import * as regression from '../../../apps/stack/scripts/perf/regression.mjs';

const counts = { requests: 4, renders: 2, commits: 1, storeNotifications: 1, socketFrames: 2, timers: 0, sqlStatements: 3 };
const run = (mode = 'counts', extra = {}) => ({ version: 5, journey: 'J1', cache: 'warm', uiMode: 'export',
  captureMode: mode, status: 'CAPTURED', durationMs: 100,
  instrumentation: { storeTelemetry: mode === 'counts', fiberHook: mode === 'counts', profiling: false },
  hostBefore: { host: 'one-host' }, counts: { ...counts }, ...extra });
const pair = (baseline = run(), candidate = run()) => ({ baseline, candidate });
const assess = pairs => regression.assessRegressionPairs(pairs, { requiredCounts: Object.keys(counts) });

test('counts reject one real regression even when another pair improves by more', () => {
  const result = assess([pair(), pair(run(), run('counts', { counts: { ...counts, requests: 5 } })),
    pair(run(), run('counts', { counts: { ...counts, requests: 0 } }))]);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.counts.find(row => row.metric === 'requests' && row.delta > 0).delta, 1);
  assert.equal(assess([pair()]).status, 'PASS');
});

test('missing, null and nonfinite counters and incomplete captures cannot become zero', () => {
  for (const value of [undefined, null, NaN, Infinity, -1]) {
    const candidate = run('counts', { counts: { ...counts, sqlStatements: value } });
    assert.equal(assess([pair(run(), candidate)]).status, 'BLOCKED');
  }
  assert.equal(assess([pair(run(), run('counts', { status: 'INCOMPLETE' }))]).status, 'BLOCKED');
  assert.equal(assess([]).status, 'BLOCKED');
});

test('unmatched journey, collector, instrumentation and execution host fail closed', () => {
  for (const extra of [{ journey: 'J5' }, { version: 4 }, { cache: 'cold' }, { uiMode: 'dev' },
    { instrumentation: { storeTelemetry: false, fiberHook: false } }, { hostBefore: { host: 'other-host' } }]) {
    assert.equal(assess([pair(run(), run('counts', extra))]).status, 'BLOCKED');
  }
});

test('paired timing ratios alert outside measured baseline spread; heavy profiling is ineligible', () => {
  const pairs = Array.from({ length: 5 }, (_, i) => pair(run('timing', { durationMs: 100 + i }), run('timing', { durationMs: 130 + i })));
  const result = assess(pairs);
  assert.equal(result.status, 'ALERT');
  assert.equal(result.timings[0].noiseRatio, 104 / 100);
  assert.ok(result.timings[0].pairedRatio > result.timings[0].noiseRatio);
  assert.equal(assess(pairs.slice(0, 4)).status, 'BLOCKED');
  assert.equal(assess([pair(run('timing'), run('timing', { instrumentation: { profiling: true } }))]).status, 'BLOCKED');
  const noisy = pairs.map((p, i) => pair({ ...p.baseline, durationMs: 100 + i * 20 }, { ...p.candidate, durationMs: 110 + i * 20 }));
  assert.equal(assess(noisy).status, 'PASS');
});

test('heap slope uses post-GC cycles and alerts on retained growth rather than allocation volume', () => {
  const samples = growth => Array.from({ length: 5 }, (_, cycle) => ({ cycle, usedBytes: 1000 + cycle * growth, forcedGc: true }));
  const result = assess([pair(run('counts', { heap: { samples: samples(0) } }), run('counts', { heap: { samples: samples(100) } }))]);
  assert.equal(result.status, 'ALERT');
  assert.equal(result.heap[0].candidateBytesPerCycle, 100);
  const bad = samples(100); bad[2].forcedGc = false;
  assert.equal(assess([pair(run('counts', { heap: { samples: samples(0) } }), run('counts', { heap: { samples: bad } }))]).status, 'BLOCKED');
});

test('backend capture roles must match and cannot supply unperturbed paired browser timings', () => {
  assert.equal(assess([pair(run(), run('counts', { backendProfileRoles: ['server'] }))]).status, 'BLOCKED');
  assert.equal(assess([pair(run('counts', { backendProfileRoles: ['server', 'daemon'] }),
    run('counts', { backendProfileRoles: ['daemon', 'server'] }))]).status, 'PASS');
  const timings = Array.from({ length: 5 }, () => pair(run('timing', { backendProfileRoles: ['server'] }),
    run('timing', { backendProfileRoles: ['server'] })));
  const result = assess(timings);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.timings.length, 0, 'instrumented paired ratios must not escape the ordinary comparison exclusion');
});

test('production bundle budget measures all emitted JS/CSS once and rejects a real added chunk', async t => {
  const temp = await createTempFixture(t, { prefix: 'happier-perf-bundle-' });
  for (const side of ['baseline', 'candidate']) {
    await mkdir(temp.path(side, 'assets'), { recursive: true });
    await writeFile(temp.path(side, 'index.html'), '<script src="assets/app.js"></script>');
    await writeFile(temp.path(side, 'assets/app.js'), 'const app = 1;');
    await writeFile(temp.path(side, 'assets/app.css'), 'body{}');
    await writeFile(temp.path(side, 'assets/app.js.map'), 'not shipped executable code');
    await writeFile(temp.path(side, 'assets/app.js.gz'), 'compressed sidecar');
  }
  const baseline = await regression.readProductionBundleSize(temp.path('baseline'));
  const before = await regression.readProductionBundleSize(temp.path('candidate'));
  assert.equal(baseline.bytes, Buffer.byteLength('const app = 1;body{}'));
  assert.equal(regression.assessBundleBudget(baseline, before).status, 'PASS');
  await writeFile(temp.path('candidate/assets/extra.js'), 'const unused = 2;');
  const after = await regression.readProductionBundleSize(temp.path('candidate'));
  assert.equal(regression.assessBundleBudget(baseline, after).status, 'FAIL');
  assert.equal(regression.assessBundleBudget(baseline, after).deltaBytes, Buffer.byteLength('const unused = 2;'));
  await mkdir(temp.path('empty'));
  await assert.rejects(regression.readProductionBundleSize(temp.path('empty')));
});

test('comparison summary retains backend CPU, event-loop and long-task observations as noisy deltas', () => {
  const baseline = run('counts', { processWindow: { server: { averageCpuPercent: 10, afterRssBytes: 200 } },
    backendProfiles: { roles: { daemon: { metrics: { delay: { p95: 3 } } } } },
    profiling: { trace: { summary: { maxTaskMs: 50 } } } });
  const candidate = { ...baseline, processWindow: { server: { averageCpuPercent: 20, afterRssBytes: 250 } } };
  const report = assess([pair(baseline, candidate)]);
  const text = regression.renderPerfComparison(report);
  assert.match(text, /averageCpuPercent.*10.*20.*10/);
  assert.match(text, /delay.p95.*3.*3.*0/);
  assert.match(text, /maxTaskMs.*50.*50.*0/);
  assert.match(text, /noisy, informational/);
});

test('comparison shows elapsed capture observations and source availability beside metric deltas', () => {
  const report = { ...assess([pair(run(), run('counts', { durationMs: 120 }))]),
    sources: { baseline: { sha: 'a'.repeat(40), dirty: false }, candidate: { sha: null, dirty: null } },
    baselineComparison: { status: 'HISTORICAL', expectedSha: 'a'.repeat(40) } };
  const elapsed = report.observations.find(row => row.metric === 'durationMs');
  assert.equal(elapsed.before, 100);
  assert.equal(elapsed.after, 120);
  assert.equal(elapsed.delta, 20);
  const text = regression.renderPerfComparison(report);
  assert.match(text, /HISTORICAL/);
  assert.ok(text.includes('a'.repeat(40)));
  assert.match(text, /durationMs.*100.*120.*20/);
  assert.match(text, /candidate source:.*unavailable.*dirty: unavailable/);
});

test('unavailable baseline still displays candidate measurements without inventing deltas', () => {
  const result = assess([{ candidate: run('counts', { processWindow: { server: { averageCpuPercent: 20 } } }) }]);
  assert.equal(result.status, 'BLOCKED');
  const requests = result.counts.find(row => row.metric === 'requests');
  assert.equal(requests.before, null);
  assert.equal(requests.after, 4);
  assert.equal(requests.delta, null);
  assert.match(regression.renderPerfComparison(result), /averageCpuPercent.*unavailable.*20.*unavailable/);
  const size = regression.assessBundleBudget(undefined, { bytes: 100, files: [] });
  assert.equal(size.deltaBytes, null);
  assert.match(regression.renderPerfComparison({ ...result, bundleSize: size }), /emitted JS\/CSS bytes.*unavailable.*100.*unavailable/);
});

test('historical exact-base artifacts compare counts across hosts but never pretend to be paired timings', () => {
  const pairs = Array.from({ length: 5 }, () => ({ ...pair(run('timing'), run('timing', { hostBefore: { host: 'new-runner' } })), historical: true }));
  const timing = assess(pairs);
  assert.equal(timing.timings.length, 0);
  assert.match(timing.gaps.join('\n'), /historical.*not paired/);
  const counts = assess([{ ...pair(run(), run('counts', { hostBefore: { host: 'new-runner' } })), historical: true }]);
  assert.equal(counts.status, 'PASS');
  assert.equal(counts.counts.find(row => row.metric === 'requests').delta, 0);
});
