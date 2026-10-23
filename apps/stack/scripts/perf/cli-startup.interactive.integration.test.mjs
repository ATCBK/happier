import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

test('stored interactive Account read keeps admission without importing unrelated transport families', async () => {
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('./cli-startup.mjs', import.meta.url)), 'contract'], {
    env: { ...process.env, CLISTART_CREDENTIAL: 'interactive', CLISTART_COMMAND: 'security', CLISTART_REPEATS: '1' },
    maxBuffer: 8 * 1024 * 1024,
  });
  const row = stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.command === 'security');
  assert.equal(row.valid, true);
  const requests = row.requests.filter(request => request.path === '/v1/account/security');
  assert.ok(requests.length > 0, 'the real admitted Action reaches the selected Account route');
  assert.ok(requests.every(request => request.method === 'GET' && request.authorized));
  assert.deepEqual(row.requests.map(({ method, path, authorized }) => ({ method, path, authorized })), [
    { method: 'GET', path: '/v1/account/security', authorized: true },
    { method: 'GET', path: '/v2/account/settings', authorized: true },
    { method: 'GET', path: '/v1/account/settings', authorized: true },
    { method: 'GET', path: '/v1/account/security', authorized: true },
  ], 'policy, supported-version fallback and fresh selected read remain; unused approval identity does not fetch');
  const trace = JSON.parse(await readFile(row.trace, 'utf8'));
  const evaluated = [...(trace.coverageAtFirstRequest ?? []), ...trace.coverage]
    .filter(script => script.functions.some(fn => fn.ranges.some(range => range.count > 0)));
  let members = evaluated.map(script => script.url);
  if (process.env.CLISTART_BUNDLE) {
    assert.ok(process.env.CLISTART_METAFILE, 'a compiled import contract needs the matching metafile');
    const { outputs } = JSON.parse(await readFile(process.env.CLISTART_METAFILE, 'utf8'));
    const emitted = Object.entries(outputs).map(([path, value]) => [path.replace(/^(?:\.\.\/)+/u, ''), value]);
    members = [...new Set(evaluated.flatMap(script => Object.entries(
      emitted.find(([path]) => script.url.endsWith(path))?.[1].inputs ?? {},
    ).filter(([, data]) => data.bytesInOutput > 0).map(([path]) => path)))];
  }
  assert.ok(members.some(path => /createCliActionExecutorFromCredentials\.[cm]?[jt]s/u.test(path)),
    'the test observes the shared credential and Action admission owner, not the PAT direct route');
  assert.ok(members.some(path => /apps\/cli\/src\/index\.[cm]?[jt]s/u.test(path)),
    'the trace and matching metafile observe the real CLI entry');
  assert.deepEqual(members.filter(path => (
    /packages\/sdk\/(?:src|dist)\//u.test(path)
    || /(?:createCredentialedFilesystemTransferClient|preparedFilesystemTransferClient)\.[cm]?[jt]s/u.test(path)
    || /daemon\/browser\/actions\/controlTransport\.[cm]?[jt]s/u.test(path)
    || /packages\/agents\/(?:src|dist)\//u.test(path)
    || /daemon\/externalActions\/daemonExternalActionTargetResolver\.[cm]?[jt]s/u.test(path)
    || /api\/session\/transcriptQueries\.[cm]?[jt]s/u.test(path)
    || /session\/services\/spawnConnectedServicesDefaults\.[cm]?[jt]s/u.test(path)
    || /session\/actions\/executeAccountPluginAction\.[cm]?[jt]s/u.test(path)
  )), [], 'interactive Account reads do not load unrelated Agent/plugin/replay, PAT SDK, browser or filesystem runtime owners');
});
