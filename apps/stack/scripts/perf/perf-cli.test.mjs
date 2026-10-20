import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';

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
