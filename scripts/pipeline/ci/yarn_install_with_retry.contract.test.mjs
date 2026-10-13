import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts', 'ci', 'yarn-install-with-retry.sh');
const shells = ['sh', 'bash', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])];

function writeExecutable(filePath, content) {
  writeFileSync(filePath, content, 'utf8');
  chmodSync(filePath, 0o755);
}

function createFakeYarnWorkspace({ installBody }) {
  const root = mkdtempSync(path.join(tmpdir(), 'yarn-install-with-retry-'));
  const binDir = path.join(root, 'bin');
  mkdirSync(binDir, { recursive: true });

  writeExecutable(
    path.join(binDir, 'yarn'),
    `#!/bin/sh
set -eu
state_file="\${FAKE_YARN_STATE_FILE:?}"
printf '%s\\n' "$*" >> "$state_file"
if [ "$#" -ge 3 ] && [ "$1" = "config" ] && [ "$2" = "set" ] && [ "$3" = "registry" ]; then
  exit 0
fi
if [ "$#" -ge 2 ] && [ "$1" = "cache" ] && [ "$2" = "clean" ]; then
  exit 0
fi
if [ "$#" -ge 1 ] && [ "$1" = "install" ]; then
${installBody}
fi
echo "unexpected yarn args: $*" >&2
exit 2
`,
  );

  return root;
}

for (const shell of shells) test(`yarn-install-with-retry defaults Redis prefetch off while preserving explicit configuration and required postinstall (${shell})`, (t) => {
  for (const override of [undefined, '0', '']) {
    // Yarn is an external process boundary. Observe its actual child environment
    // and a required postinstall output without downloading or compiling Redis.
    const root = createFakeYarnWorkspace({
      installBody: `  printf '%s' "\${REDISMS_DISABLE_POSTINSTALL-unset}" > "\${FAKE_REDIS_POSTINSTALL_CONFIG_PATH:?}"
  printf 'required postinstall completed' > "\${FAKE_REQUIRED_POSTINSTALL_PATH:?}"
  exit 0`,
    });
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const configPath = path.join(root, 'redis-postinstall-config');
    const requiredOutputPath = path.join(root, 'required-postinstall-output');
    const env = {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_YARN_STATE_FILE: path.join(root, 'state.log'),
      YARN_INSTALL_LOG_PATH: path.join(root, 'install.log'),
      FAKE_REDIS_POSTINSTALL_CONFIG_PATH: configPath,
      FAKE_REQUIRED_POSTINSTALL_PATH: requiredOutputPath,
    };
    delete env.REDISMS_DISABLE_POSTINSTALL;
    if (override !== undefined) env.REDISMS_DISABLE_POSTINSTALL = override;
    const res = spawnSync(shell, [scriptPath, '--frozen-lockfile'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    });

    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(configPath, 'utf8'), override ?? '1');
    assert.equal(readFileSync(requiredOutputPath, 'utf8'), 'required postinstall completed');
    assert.deepEqual(readFileSync(path.join(root, 'state.log'), 'utf8').trim().split('\n'), [
      'config set registry https://registry.npmjs.org/',
      'install --frozen-lockfile',
    ]);
  }
});

for (const shell of shells) test(`yarn-install-with-retry preserves scoped first-party postinstalls and required third-party scripts (${shell})`, (t) => {
  const root = createFakeYarnWorkspace({
    installBody: `  "\${FAKE_NODE_EXECUTABLE:?}" -e 'const {shouldRunPostinstall}=require(process.env.FAKE_POSTINSTALL_GATE); const fs=require("node:fs"); const admitted=["protocol","agents","plugin-sdk","ui","cli"].filter(workspace=>shouldRunPostinstall({workspace,scope:process.env.HAPPIER_INSTALL_SCOPE})); fs.writeFileSync(process.env.FAKE_SCOPE_OUTPUT,JSON.stringify(admitted)); fs.writeFileSync(process.env.FAKE_THIRD_PARTY_OUTPUT,"required native install complete");'
  exit 0`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const gatePath = path.join(repoRoot, 'scripts/postinstall/shouldRunPostinstall.cjs');
  const gateBefore = readFileSync(gatePath, 'utf8');
  const scopeOutput = path.join(root, 'scope.json');
  const thirdPartyOutput = path.join(root, 'native-output');
  const res = spawnSync(shell, [scriptPath, '--frozen-lockfile'], {
    cwd: repoRoot, encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      HAPPIER_INSTALL_SCOPE: 'ui,cli', FAKE_YARN_STATE_FILE: path.join(root, 'state.log'),
      YARN_INSTALL_LOG_PATH: path.join(root, 'install.log'), FAKE_NODE_EXECUTABLE: process.execPath,
      FAKE_POSTINSTALL_GATE: gatePath, FAKE_SCOPE_OUTPUT: scopeOutput, FAKE_THIRD_PARTY_OUTPUT: thirdPartyOutput },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(readFileSync(scopeOutput, 'utf8')), ['ui', 'cli']);
  assert.equal(readFileSync(thirdPartyOutput, 'utf8'), 'required native install complete');
  assert.equal(readFileSync(gatePath, 'utf8'), gateBefore);
});

for (const shell of shells) test(`yarn-install-with-retry streams and retains successful install stdout and stderr (${shell})`, async (t) => {
  const root = createFakeYarnWorkspace({
    installBody: `  echo '[1/4] Resolving packages...'
  IFS= read -r release
  [ "$release" = 'continue' ]
  echo '[2/4] Fetching packages...'
  echo 'warning optional package diagnostic' >&2
  echo '[3/4] Linking dependencies...'
  echo '[4/4] Building fresh packages...'
  echo 'postinstall completed'
  exit 0`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.log');
  const logPath = path.join(root, 'install.log');
  const args = ['--frozen-lockfile', '--ignore-engines', '--network-timeout', '600000', '--prefer-offline', '--non-interactive'];

  const child = spawn(shell, [scriptPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_YARN_STATE_FILE: stateFile,
      YARN_INSTALL_LOG_PATH: logPath,
      NPM_TOKEN: 'fixture-private-install-token',
    },
  });
  t.after(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completion = once(child, 'close');
  // The fake OS child cannot finish until acknowledged; the timeout only releases
  // a broken wrapper for a bounded failure, not an installer performance limit.
  const phaseObserved = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) })
    .then(() => stdout.includes('[1/4] Resolving packages...'), () => false);
  const outputBeforeCompletion = stdout;
  child.stdin.end('continue\n');
  const [status] = await completion;

  assert.equal(status, 0, `expected install success, stderr:\n${stderr}`);
  assert.ok(phaseObserved, 'expected the first install phase in the job output before releasing the installer');
  assert.equal(outputBeforeCompletion, '[1/4] Resolving packages...\n');
  const expectedOutput = '[1/4] Resolving packages...\n[2/4] Fetching packages...\nwarning optional package diagnostic\n[3/4] Linking dependencies...\n[4/4] Building fresh packages...\npostinstall completed\n';
  assert.equal(stdout, expectedOutput, 'expected both install streams in the successful job output');
  assert.ok(!(stdout + stderr).includes('fixture-private-install-token'), 'expected private auth environment not to be echoed');
  assert.equal(readFileSync(logPath, 'utf8'), expectedOutput, 'expected the successful installer log to remain available');
  assert.deepEqual(readFileSync(stateFile, 'utf8').trim().split('\n'), [
    'config set registry https://registry.npmjs.org/',
    `install ${args.join(' ')}`,
  ]);
});

for (const shell of shells) test(`yarn-install-with-retry retries transient registry failures and clears the cache before retrying (${shell})`, (t) => {
  const root = createFakeYarnWorkspace({
    installBody: `  count_file="\${FAKE_YARN_INSTALL_COUNT_FILE:?}"
  count=0
  if [ -f "$count_file" ]; then
    count="$(cat "$count_file")"
  fi
  count=$((count + 1))
  printf '%s' "$count" > "$count_file"
  if [ "$count" -eq 1 ]; then
    echo 'error https://registry.yarnpkg.com/@img/sharp-linux-arm/-/sharp-linux-arm-0.34.5.tgz: Request failed "502 Bad Gateway"' >&2
    exit 1
  fi
  echo 'postinstall completed after retry'
  exit 0`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.log');
  const installCountFile = path.join(root, 'install-count.txt');
  const logPath = path.join(root, 'install.log');

  const res = spawnSync(shell, [scriptPath, '--frozen-lockfile', '--ignore-engines'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_YARN_STATE_FILE: stateFile,
      FAKE_YARN_INSTALL_COUNT_FILE: installCountFile,
      YARN_INSTALL_LOG_PATH: logPath,
      YARN_INSTALL_RETRY_SLEEP_SECONDS: '0',
    },
  });

  assert.equal(res.status, 0, `expected retrying install to succeed, stderr:\n${res.stderr}`);
  assert.equal(res.stdout, 'error https://registry.yarnpkg.com/@img/sharp-linux-arm/-/sharp-linux-arm-0.34.5.tgz: Request failed "502 Bad Gateway"\npostinstall completed after retry\n');
  assert.equal(readFileSync(logPath, 'utf8'), 'postinstall completed after retry\n');
  assert.match(res.stderr, /retrying/);
  const stateLines = readFileSync(stateFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(
    stateLines,
    [
      'config set registry https://registry.npmjs.org/',
      'install --frozen-lockfile --ignore-engines',
      'cache clean',
      'install --frozen-lockfile --ignore-engines',
    ],
    'expected a transient failure to trigger cache cleanup and a second install attempt',
  );
});

for (const shell of shells) test(`yarn-install-with-retry does not retry non-transient failures (${shell})`, (t) => {
  const root = createFakeYarnWorkspace({
    installBody: `  echo 'error Command failed with exit code 1.' >&2
  exit 42`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.log');

  const res = spawnSync(shell, [scriptPath, '--frozen-lockfile'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_YARN_STATE_FILE: stateFile,
      YARN_INSTALL_LOG_PATH: path.join(root, 'install.log'),
      YARN_INSTALL_RETRY_SLEEP_SECONDS: '0',
    },
  });

  assert.equal(res.status, 1, 'expected non-transient install failure to preserve the wrapper failure status');
  assert.equal(res.stdout, 'error Command failed with exit code 1.\n');
  assert.equal(readFileSync(path.join(root, 'install.log'), 'utf8'), res.stdout);
  const stateLines = readFileSync(stateFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(
    stateLines,
    ['config set registry https://registry.npmjs.org/', 'install --frozen-lockfile'],
    'expected non-transient failures to stop after the first install attempt',
  );
  assert.match(res.stderr, /non-transient error/i, 'expected stderr to explain that the failure was not retried');
});

for (const shell of shells) test(`yarn-install-with-retry refuses successful install when log streaming fails (${shell})`, (t) => {
  const root = createFakeYarnWorkspace({ installBody: "  echo 'postinstall completed'\n  exit 0" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // tee is an external OS process boundary; fail after draining the real child.
  writeExecutable(path.join(root, 'bin', 'tee'), '#!/bin/sh\ncat > "$1"\ncat "$1"\nexit 73\n');
  const stateFile = path.join(root, 'state.log');
  const logPath = path.join(root, 'install.log');
  const res = spawnSync(shell, [scriptPath, '--frozen-lockfile'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_YARN_STATE_FILE: stateFile,
      YARN_INSTALL_LOG_PATH: logPath,
      YARN_INSTALL_RETRY_SLEEP_SECONDS: '0',
    },
  });
  assert.equal(res.status, 1, 'expected a failed log sink not to certify an install as successful');
  assert.equal(res.stdout, 'postinstall completed\n');
  assert.equal(readFileSync(logPath, 'utf8'), res.stdout);
  assert.deepEqual(readFileSync(stateFile, 'utf8').trim().split('\n'), [
    'config set registry https://registry.npmjs.org/',
    'install --frozen-lockfile',
  ]);
});

test('yarn-install-with-retry executes directly without bash on PATH for alpine docker stages', (t) => {
  const root = createFakeYarnWorkspace({
    installBody: '  exit 0',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.log');
  const installedScriptPath = path.join(root, 'yarn-install-with-retry');
  copyFileSync(scriptPath, installedScriptPath);
  chmodSync(installedScriptPath, 0o755);

  const res = spawnSync(installedScriptPath, ['--frozen-lockfile'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:/usr/bin:/usr/sbin:/sbin`,
      FAKE_YARN_STATE_FILE: stateFile,
      YARN_INSTALL_LOG_PATH: path.join(root, 'install.log'),
      YARN_INSTALL_RETRY_SLEEP_SECONDS: '0',
    },
  });

  assert.equal(res.status, 0, `expected direct-exec install helper to avoid requiring bash on PATH, stderr:\n${res.stderr}`);
  const stateLines = readFileSync(stateFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.deepEqual(
    stateLines,
    ['config set registry https://registry.npmjs.org/', 'install --frozen-lockfile'],
    'expected the shared helper to run successfully when directly executed in alpine-like environments without bash',
  );
});
