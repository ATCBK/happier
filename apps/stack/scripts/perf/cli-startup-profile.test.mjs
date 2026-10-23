import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('startup attribution excludes CPU and Home reads after the first request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cli-startup-profile-'));
  try {
    await mkdir(join(root, 'apps/cli'), { recursive: true });
    await writeFile(join(root, 'apps/cli/metafile.json'), JSON.stringify({ outputs: {} }));
    await writeFile(join(root, 'bundle-security-cpu-profile.json'), JSON.stringify({
      coverage: [], coverageAtFirstRequest: [], events: [
        { kind: 'existsSync', path: '/fixture/settings', ms: 1 },
        { kind: 'existsSync:end', path: '/fixture/settings', ms: 2 },
        { kind: 'http:request', clockUs: 200, ms: 10 },
        { kind: 'readFile:start', path: '/fixture/settings', ms: 20 },
        { kind: 'readFile:end', path: '/fixture/settings', ms: 22 },
      ],
    }));
    const frame = name => ({ functionName: name, scriptId: '1', url: 'file:///fixture.mjs', lineNumber: 0, columnNumber: 0 });
    await writeFile(join(root, 'bundle-security.cpuprofile'), JSON.stringify({
      startTime: 100, endTime: 500, samples: [2, 3], timeDeltas: [100, 200], nodes: [
        { id: 1, callFrame: frame('(root)'), children: [2, 3] },
        { id: 2, callFrame: frame('readSettingsBeforeRequest') },
        { id: 3, callFrame: frame('readSettingsAfterRequest') },
      ],
    }));
    await execute(process.execPath, [fileURLToPath(new URL('./cli-startup-profile.mjs', import.meta.url)),
      root, root, 'bundle:security']);
    const [row] = JSON.parse(await readFile(join(root, 'attribution.json'), 'utf8'));
    assert.equal(row.cpuScope, 'before-first-request');
    assert.deepEqual(row.topSelfCpu.map(({ name, ms }) => ({ name, ms })), [
      { name: 'readSettingsBeforeRequest file:///fixture.mjs', ms: 0.1 },
    ]);
    assert.equal(row.homeFileIo.contentReads, 1, 'whole-operation IO remains separately visible');
    assert.deepEqual(row.preRequestHomeFileIo, {
      existenceProbes: 1, existenceMs: 1, contentReads: 0, contentReadMs: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
