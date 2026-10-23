import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const execute = promisify(execFile);

test('local CLI information performs no network or terminal integration work; authenticated read keeps admission', async () => {
  // Real source entry point, real filesystem and loopback HTTP: no internal
  // dispatch, credential, registry or authorization collaborator is mocked.
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('./cli-startup.mjs', import.meta.url)), 'contract'], {
    env: { ...process.env, CLISTART_REPEATS: '1' }, maxBuffer: 8 * 1024 * 1024,
  });
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.command);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.valid, true, `${row.command} must complete successfully`);
    if (row.command !== 'security') {
      assert.equal(row.requests.length, 0, `${row.command} is credential-free`);
      const trace = JSON.parse(await readFile(row.trace, 'utf8'));
      assert.equal(trace.events.filter(event => event.kind === 'http:request'
        || (event.kind === 'socket:start' && event.transport !== 'ipc')).length, 0,
        `${row.command} opens no network transport`);
      const scripts = trace.events.filter(event => event.kind === 'script:parsed').map(event => event.url);
      assert.equal(scripts.filter(path => /\/integrations\/(?:herdr|zellij)\//u.test(path)).length, 0,
        `${row.command} does not start a terminal host`);
      assert.equal(scripts.filter(path => /\/packagedRuntime\/js\/ensureJavaScriptRuntimeExecutable/u.test(path)).length, 0,
        `${row.command} has no managed runtime to install`);
    } else {
      assert.deepEqual(row.requests.map(({ method, path, authorized }) => ({ method, path, authorized })), [
        { method: 'GET', path: '/v1/account/security', authorized: true },
      ]);
      const trace = JSON.parse(await readFile(row.trace, 'utf8'));
      assert.equal(trace.events.filter(event => event.kind === 'dns:lookup').length, 0,
        'the numeric loopback fixture needs no DNS lookup');
      const evaluated = (trace.coverageAtFirstRequest ?? []).filter(script => script.functions.some(fn => (
        fn.ranges.some(range => range.count > 0)
      ))).map(script => script.url);
      assert.ok(evaluated.some(url => url.endsWith('/cli/commands/auth/accountSecurity.ts')),
        'the cost contract observes the real authenticated security read owner');
      assert.deepEqual(evaluated.filter(url => (
        /\/protocol\/(?:src|dist)\/(?:auth\/(?:entry|externalOAuth)|actions\/actionSpecs)\.[cm]?[jt]s$/u.test(url)
        || /\/(?:features\/serverFeaturesClient|auth\/externalAuthProof)\.[cm]?[jt]s$/u.test(url)
        || /\/plugins\/runtime\/policy\/evaluate\.[cm]?[jt]s$/u.test(url)
        || /\/packages\/agents\/src\/index\.[cm]?[jt]s$/u.test(url)
      )), [], 'a PAT security read evaluates no mutation, discovery, execution-policy or Agent-installation catalog');
    }
  }
});
