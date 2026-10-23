import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('startup probe observes fetch and Node HTTP without recording credentials or query strings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-startup-probe-'));
  const trace = join(root, 'trace.json');
  const server = createServer((_request, response) => response.end('{}'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await execute(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${root}`, '--cpu-prof-name=probe.cpuprofile',
      '--require', fileURLToPath(new URL('./cli-startup-probe.cjs', import.meta.url)),
      '--input-type=module', '--eval', `
        import http from 'node:http';
        await (await fetch(${JSON.stringify(base + '/features?probe-secret=not-for-trace')}, {
          headers: { Authorization: 'Bearer fixture-secret-not-for-trace' },
        })).text();
        await new Promise((resolve, reject) => {
          const request = http.request(${JSON.stringify(base + '/security?probe-secret=not-for-trace')}, response => {
            response.resume(); response.on('end', resolve);
          });
          request.on('error', reject); request.end();
        });
      `], { env: { ...process.env, CLISTART_TRACE: trace, CLISTART_IMPORT_TRACE: '1' } });
    const raw = await readFile(trace, 'utf8');
    const data = JSON.parse(raw);
    const profile = JSON.parse(await readFile(join(root, 'probe.cpuprofile'), 'utf8'));
    assert.deepEqual(data.events.filter(event => event.kind === 'http:request').map(event => event.path), ['/features', '/security']);
    const firstRequest = data.events.find(event => event.kind === 'http:request');
    assert.ok(firstRequest.clockUs >= profile.startTime && firstRequest.clockUs <= profile.endTime,
      'request creation and CPU samples share a measured monotonic clock');
    assert.ok(data.coverageAtFirstRequest.length > 0, 'first fetch captures pre-request module coverage');
    assert.equal(raw.includes('fixture-secret-not-for-trace'), false);
    assert.equal(raw.includes('probe-secret='), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
