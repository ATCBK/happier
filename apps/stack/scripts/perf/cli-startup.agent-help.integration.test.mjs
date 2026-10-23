import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('Agent help preserves the real native-help boundary without session runtime or catalog activation', async () => {
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('./cli-startup.mjs', import.meta.url)), 'contract'], {
    env: { ...process.env, CLISTART_COMMAND: 'agent-help', CLISTART_REPEATS: '1' }, maxBuffer: 8 * 1024 * 1024,
  });
  const row = stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.command === 'agent-help');
  assert.equal(row.valid, true);
  assert.deepEqual(row.requests, [], 'help performs no Home request');
  const output = await readFile(row.stdoutPath, 'utf8');
  assert.match(output, /Happier session options:/u);
  assert.match(output, /Native help fixture \["--help"\]/u, 'the actual vendor help process still runs');
  const trace = JSON.parse(await readFile(row.trace, 'utf8'));
  const evaluated = trace.coverage.filter(script => script.functions.some(fn => fn.ranges.some(range => range.count > 0)));
  let members = evaluated.map(script => script.url);
  if (process.env.CLISTART_BUNDLE) {
    assert.ok(process.env.CLISTART_METAFILE);
    const { outputs } = JSON.parse(await readFile(process.env.CLISTART_METAFILE, 'utf8'));
    const emitted = Object.entries(outputs).map(([path, value]) => [path.replace(/^(?:\.\.\/)+/u, ''), value]);
    members = [...new Set(evaluated.flatMap(script => Object.entries(
      emitted.find(([path]) => script.url.endsWith(path))?.[1].inputs ?? {},
    ).filter(([, data]) => data.bytesInOutput > 0).map(([path]) => path)))];
  }
  assert.ok(members.some(path => /apps\/cli\/src\/index\.[jt]s/u.test(path)), 'observe the real CLI entry');
  assert.deepEqual(members.filter(path => (
    /apps\/cli\/src\/(?:cli\/runBackendSessionCliCommand|agent\/catalog\/snapshot|plugins\/projection\/registry\/createResolvedContributionRegistry)\.[jt]s/u.test(path)
    || /packages\/(?:sdk|plugin-sdk)\/(?:src|dist)\//u.test(path)
    || /packages\/agents\/(?:src|dist)\/index\.[jt]s/u.test(path)
  )), [], 'native help needs admitted launch metadata, not session execution or the full registry');
});
