import assert from 'node:assert/strict';
import test from 'node:test';
import * as command from './stack_stop_command.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMutagenSessionName } from '../utils/dev_targets/mutagen_project.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../testkit/core/fake_bin_harness.mjs';
import { runNodeCapture } from '../testkit/core/run_node_capture.mjs';

test('public stop admits daemon preservation independently of aggressive cleanup', () => {
  assert.equal(typeof command.resolveStackStopOptions, 'function');
  assert.deepEqual(command.resolveStackStopOptions(['--preserve-daemon', '--no-docker']), {
    noDocker: true, aggressive: false, sweepOwned: false, preserveDaemon: true,
  });
  assert.equal(command.resolveStackStopOptions([]).preserveDaemon, false);
});

test('public stop prints its failing browser target and redacted cause', { skip: process.platform === 'win32' }, async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-stop-cause-' });
  const stackName = 'fixture-stop-cause';
  const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));
  const stackDir = join(repoDir, 'apps/stack');
  const baseDir = join(root, stackName);
  await mkdir(baseDir);
  await writeFile(join(baseDir, 'env'), `HAPPIER_TEST_API_TOKEN=fixture-secret-token\nHAPPIER_STACK_REPO_DIR=${stackDir}\n`);
  await writeFile(join(baseDir, 'dev-targets.json'), JSON.stringify({ version: 3,
    targets: [{ name: 'stale-worker', platform: 'posix', ssh: 'stale-worker', repoDir: '/stale/mirror', cliHomeDir: '/fixture' }],
  }));
  const { binDir } = writeFakeBin({ root, name: 'ssh', content: `#!${process.execPath}
process.stderr.write('Cannot find module localSourceRuntimeBootstrap.mjs fixture-secret-token');
process.exit(1);
` });
  writeFakeBin({ root, name: 'mutagen', content: `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='sync' && args[1]==='list') {
  // The mirror is owned by the repository, even when Stop receives a package path.
  const name=${JSON.stringify(resolveMutagenSessionName('stale-worker', repoDir))};
  console.log(args.at(-1)==='{{json .}}'
    ? JSON.stringify([{name,paused:false,status:'watching',successfulCycles:1,alpha:{connected:true,scanned:true},beta:{connected:true,scanned:true}}])
    : name+'|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|1|ok|0|0');
}
` });
  for (const json of [false, true]) {
    const result = await runNodeCapture(['--input-type=module', '-e', `
    import { runStackStopCommand } from ${JSON.stringify(new URL('./stack_stop_command.mjs', import.meta.url).href)};
    await runStackStopCommand({rootDir:${JSON.stringify(stackDir)},stackName:${JSON.stringify(stackName)},passthrough:['--no-docker'],json:${json}});
  `], { env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HAPPIER_STACK_STORAGE_DIR: root,
    HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: stackName, HAPPIER_STACK_ENV_FILE: join(baseDir, 'env'),
    HAPPIER_STACK_REPO_DIR: stackDir, HAPPIER_STACK_NO_DEV_TARGETS: '', HAPPIER_TEST_API_TOKEN: '' } });
    assert.equal(result.code, 1, result.stdout + result.stderr);
    const diagnostic = json ? JSON.parse(result.stdout).stopped.errors[0].error : result.stderr;
    assert.match(diagnostic, /stale-worker.*Cannot find module localSourceRuntimeBootstrap\.mjs/);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret-token/);
  }
});
