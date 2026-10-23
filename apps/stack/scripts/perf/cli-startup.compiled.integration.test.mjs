import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

test('compiled local information loads only its metadata owners and preserves help bytes', async (t) => {
  assert.ok(process.env.CLISTART_BUNDLE, 'provide the built CLI entry');
  assert.ok(process.env.CLISTART_METAFILE, 'provide the matching esbuild metafile');
  assert.ok(process.env.CLISTART_HELP_BASELINE, 'provide the pre-change help stdout');
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('./cli-startup.mjs', import.meta.url)), 'contract'], {
    env: { ...process.env, CLISTART_BUNDLE_ONLY: '1', CLISTART_REPEATS: '1' }, maxBuffer: 8 * 1024 * 1024,
  });
  const { outputs } = await readJson(process.env.CLISTART_METAFILE);
  const emitted = Object.entries(outputs).map(([path, value]) => [path.replace(/^(?:\.\.\/)+/u, ''), value]);
  const findOutput = url => emitted.find(([path]) => url.endsWith(path))?.[1];
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.command);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    await t.test(row.command, async () => {
    assert.equal(row.valid, true, `${row.command} completes`);
    if (row.command === 'security') {
      assert.deepEqual(row.requests.map(({ method, path, authorized }) => ({ method, path, authorized })), [
        { method: 'GET', path: '/v1/account/security', authorized: true },
      ]);
      const trace = await readJson(row.trace);
      const evaluated = (trace.coverageAtFirstRequest ?? []).filter(script => script.functions.some(fn => (
        fn.ranges.some(range => range.count > 0)
      )));
      const inputs = [...new Set(evaluated.flatMap(script => Object.entries(findOutput(script.url)?.inputs ?? {})
        .filter(([, data]) => data.bytesInOutput > 0).map(([path]) => path)))];
      assert.ok(inputs.some(path => path.endsWith('/cli/commands/auth/accountSecurity.ts')),
        'the matching metafile observes the real authenticated read owner');
      assert.deepEqual(inputs.filter(path => (
        /packages\/protocol\/src\/(?:auth\/(?:entry|externalOAuth)|actions\/actionSpecs)\.ts$/u.test(path)
        || /apps\/cli\/src\/(?:features\/serverFeaturesClient|auth\/externalAuthProof)\.ts$/u.test(path)
        || /apps\/cli\/src\/plugins\/runtime\/policy\/evaluate\.ts$/u.test(path)
        || /packages\/(?:agents\/src\/index|cli-common\/src\/agents\/install)\.ts$/u.test(path)
      )), [], 'the read does not evaluate mutation, discovery or Agent-installation catalogs');
      assert.equal(trace.events.filter(event => event.kind === 'dns:lookup').length, 0,
        'the numeric loopback fixture needs no DNS lookup');
      return;
    }
    assert.equal(row.requests.length, 0, `${row.command} is network-free`);
    const trace = await readJson(row.trace);
    assert.equal(trace.events.filter(event => event.kind === 'http:request'
      || (event.kind === 'socket:start' && event.transport !== 'ipc')).length, 0,
      `${row.command} opens no network transport`);
    assert.equal(trace.events.filter(event => event.kind === 'coverage:error').length, 0);
    const evaluated = trace.coverage.filter(script => script.functions.some(fn => fn.ranges.some(range => range.count > 0)));
    assert.ok(evaluated.length > 0, 'the evaluator hook must observe execution');
    // A chunk's retained inputs are a conservative loaded-module count, not a
    // require.cache count or a claim that an uncalled function body executed.
    const inputs = [...new Set(evaluated.flatMap(script => Object.entries(findOutput(script.url)?.inputs ?? {})
      .filter(([, data]) => data.bytesInOutput > 0).map(([path]) => path)))];
    assert.ok(inputs.some(path => path.endsWith('apps/cli/src/index.ts')), 'metafile must match the executing CLI entry');
    const heavy = inputs.filter(path => /(?:packages\/(?:protocol|plugin-sdk|agents|plugins)\/|apps\/cli\/src\/(?:configuration\.ts|providers\/|agent\/catalog\/|plugins\/runtime\/|plugins\/projection\/registry\/createResolvedContributionRegistry))/u.test(path));
    assert.equal(heavy.length, 0, `${row.command} must not evaluate runtime/schema/catalog owners; first: ${heavy.slice(0, 5).join(', ')}`);
    if (row.command === 'noop') {
      const cliModules = inputs.filter(path => /apps\/cli\/src\//u.test(path));
      assert.deepEqual(cliModules.filter(path => !/\/(?:index|cli\/(?:processArgs|version)|utils\/writeConsoleBestEffort)\.ts$/u.test(path)), []);
    } else {
      assert.equal(await readFile(row.stdoutPath, 'utf8'), await readFile(process.env.CLISTART_HELP_BASELINE, 'utf8'),
        'root help remains byte-identical');
      const implementations = inputs.filter(path => /apps\/cli\/src\/cli\/commands\//u.test(path)
        && !/\/commands\/(?:shared\/argvFlags|session\/shared\/sessionCommandLabels)\.ts$/u.test(path));
      assert.deepEqual(implementations, [], 'root help does not load command implementations');
    }
    });
  }
});
