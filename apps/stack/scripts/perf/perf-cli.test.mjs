import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';
import { runInNewContext } from 'node:vm';
import { navigateToRestoreInput } from './perf.mjs';

test('cold restore waits for a clicked screen to leave before choosing its next control', async () => {
  // The browser/DOM is the external boundary: React navigation may commit after
  // the click command has returned. Keep the actual navigation loop/predicates.
  let screen = 'Skip', pending;
  const evaluate = async expression => runInNewContext(expression, { document: {
    querySelector: () => screen === 'input' ? {} : null,
    querySelectorAll: () => screen === 'input' ? [] : [{ textContent: screen, getClientRects: () => [1] }],
  } });
  const browser = async args => {
    if (args[0] === 'wait') {
      if (!await evaluate(args[2]) && pending) { screen = pending; pending = undefined; }
      const ready = await evaluate(args[2]);
      // agent-browser evaluates by value over CDP: a DOM element result fails
      // serialization rather than behaving like a truthy Playwright predicate.
      assert.equal(typeof ready, 'boolean', 'browser wait predicates must return a primitive');
      assert.ok(ready, 'browser wait must reach its requested screen state');
    } else {
      assert.equal(args.at(-1), screen);
      assert.equal(pending, undefined, 'must not click the departing control twice');
      pending = screen === 'Skip' ? 'Use a key' : 'input';
    }
  };
  await navigateToRestoreInput(browser, evaluate);
  assert.equal(screen, 'input');
});

test('the existing audit CLI reads journey bundles and prints the measured comparison through its E2E mode', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-perf-cli-' });
  for (const side of ['before', 'after']) for (let index = 0; index < 5; index++) {
    const directory = fixture.path(side, String(index));
    await mkdir(directory, { recursive: true });
    await writeFile(fixture.path(side, String(index), 'bundle.json'), JSON.stringify({
      journey: 'J1', cache: 'cold', uiMode: 'export', status: 'CAPTURED', durationMs: side === 'before' ? 10 : 5,
      captureMode: 'timing', instrumentation: { storeTelemetry: false, fiberHook: false },
      counts: { requests: side === 'before' ? 5 : 1 },
    }));
  }
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const result = await runNodeCapture(['apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs', 'compare', fixture.path('before'), fixture.path('after')], { cwd: repo, env: process.env });
  assert.equal(result.code, 0, result.stderr);
  const rows = result.stdout.split('\n').map(line => line.split('|').map(cell => cell.trim()));
  assert.deepEqual(rows.find(row => row[2] === 'requests')?.slice(3, 6), ['5', '1', '-4']);
  assert.deepEqual(rows.find(row => row[2]?.startsWith('p95Ms'))?.slice(3, 6), ['10', '5', '-5']);
});
