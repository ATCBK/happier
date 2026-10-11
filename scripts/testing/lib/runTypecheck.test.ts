import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { ROOT_TYPECHECK_COMMANDS, runRootTypecheck } from '../runTypecheck.ts';

const rootPackage = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>;
};

test('root typecheck delegates to the phase runner without replacing the heartbeat owner', () => {
  assert.equal(
    rootPackage.scripts?.['typecheck:inner'],
    'node --experimental-strip-types scripts/testing/runTypecheck.ts',
  );
  assert.equal(
    rootPackage.scripts?.['typecheck:local'],
    'node scripts/runWithHeartbeat.mjs --label typecheck -- yarn -s typecheck:inner',
  );
});

test('root typecheck plan preserves prerequisite order and every Turbo workspace owner', () => {
  assert.deepEqual(ROOT_TYPECHECK_COMMANDS.map((command) => command.args), [
    ['-s', 'prepare:typecheck:workspaces'],
    [
      'turbo',
      'run',
      'typecheck:finite',
      '--continue=always',
      '--filter=@happier-dev/plugin-sdk',
      '--filter=@happier-dev/sdk',
    ],
    [
      'turbo',
      'run',
      'typecheck:source:finite',
      '--continue=always',
      '--filter=@happier-dev/terminal-native',
      '--filter=@happier-dev/plugin-ui',
      '--filter=@happier-dev/app',
      '--filter=@happier-dev/cli',
      '--filter=@happier-dev/server',
      '--filter=@happier-dev/tests',
    ],
    [
      'tsc', '--noEmit',
      '-p', 'packages/protocol/tsconfig.json',
      '-p', 'packages/plugins/triage/tsconfig.json',
    ],
  ]);
});

test('root typecheck attempts every phase sequentially before reporting complete failures', async () => {
  const executed: string[] = [];
  let active = 0;
  let maximumActive = 0;

  await assert.rejects(
    runRootTypecheck({
      commands: [
        { id: 'build-packages', args: ['-s', 'build:packages'] },
        { id: 'public-sdk', args: ['turbo', 'run', 'typecheck:finite'] },
        { id: 'source-workspaces', args: ['turbo', 'run', 'typecheck:source:finite'] },
      ],
      runCommand: async (command) => {
        executed.push(command.id);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolveRun) => setImmediate(resolveRun));
        active -= 1;
        if (command.id !== 'source-workspaces') throw new Error(`${command.id} failed`);
      },
    }),
    (error: unknown) => {
      assert.match(String(error), /build-packages: build-packages failed/u);
      assert.match(String(error), /public-sdk: public-sdk failed/u);
      return true;
    },
  );

  assert.deepEqual(executed, ['build-packages', 'public-sdk', 'source-workspaces']);
  assert.equal(maximumActive, 1);
});

test('compiler-only typecheck stops before consumers when combined package preparation fails', async () => {
  const executed: string[] = [];
  await assert.rejects(runRootTypecheck({
    compilerOnly: true,
    runCommand: async (command) => {
      executed.push(command.id);
      if (command.id === 'prepare-workspaces') throw new Error('current declarations unavailable');
    },
  }), /current declarations unavailable/u);
  assert.deepEqual(executed, ['prepare-workspaces']);
});

test('compiler-only typecheck executes compilers after preparation and reports compiler failures', async () => {
  const executed: string[][] = [];
  await assert.rejects(runRootTypecheck({
    compilerOnly: true,
    runCommand: async ({ args }) => {
      executed.push([...args]);
      if (args.includes('--noEmit')) throw new Error('compiler rejected source');
    },
  }), /compiler rejected source/u);
  assert.ok(executed.length > 2);
  const uiCommands = executed.filter((args) => args.includes('apps/ui'));
  assert.deepEqual(uiCommands, [['--cwd', 'apps/ui', '-s', 'typecheck']]);
  const cliCommands = executed.filter((args) => args.includes('apps/cli'));
  assert.deepEqual(cliCommands, [['--cwd', 'apps/cli', '-s', 'typecheck']]);
  const serverCommands = executed.filter((args) => args.includes('apps/server'));
  assert.deepEqual(serverCommands, [['--cwd', 'apps/server', '-s', 'typecheck']],
    'server compilation must use the package owner that prepares generated Prisma clients');
  const testsCommands = executed.filter((args) => args.includes('packages/tests'));
  assert.deepEqual(testsCommands, [['--cwd', 'packages/tests', '-s', 'typecheck']]);
  const uiPackage = JSON.parse(readFileSync('apps/ui/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(uiPackage.scripts.typecheck, '../stack/bin/hstack-exec --script=typecheck:local');
  assert.equal(uiPackage.scripts['typecheck:local'], 'yarn -s typecheck:source:finite');
  const [executable, owner, ...compilerArgs] = uiPackage.scripts['typecheck:source:finite'].trim().split(/\s+/u);
  assert.equal(executable, 'node');
  assert.equal(resolve('apps/ui', owner), resolve('scripts/workspaces/runTypeScriptCli.mjs'));
  assert.deepEqual(compilerArgs.filter((_, index) => compilerArgs[index - 1] === '--project'), [
    'tsconfig.foundation.json', 'tsconfig.core.json', 'tsconfig.source.json',
    'tsconfig.test-components.json', 'tsconfig.test-other.json',
  ]);
  for (const args of executed.slice(1)) {
    if (!uiCommands.includes(args) && !cliCommands.includes(args) && !serverCommands.includes(args) && !testsCommands.includes(args)) {
      assert.equal(args[0], 'tsc');
      assert.ok(args.includes('--noEmit'));
    }
  }
  assert.ok(executed.some((args) => args.includes('packages/protocol/tsconfig.json')));
  assert.ok(executed.some((args) => args.includes('packages/plugins/triage/tsconfig.json')));
  const cliPackage = JSON.parse(readFileSync('apps/cli/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(cliPackage.scripts.typecheck, '../stack/bin/hstack-exec --script=typecheck:local');
  assert.equal(cliPackage.scripts['typecheck:local'], 'yarn -s typecheck:source:finite');
  const [cliExecutable, cliOwner, ...cliCompilerArgs] = cliPackage.scripts['typecheck:source:finite'].trim().split(/\s+/u);
  assert.equal(cliExecutable, 'node');
  assert.equal(resolve('apps/cli', cliOwner), resolve('scripts/workspaces/runTypeScriptCli.mjs'));
  assert.deepEqual(cliCompilerArgs.filter((_, index) => cliCompilerArgs[index - 1] === '--project'), [
    'tsconfig.source.json', 'tsconfig.test.json',
  ]);
});

test('current-run prepared compiler mode omits only preparation and retains every compiler owner', async () => {
  const ordinary: string[][] = [];
  const prepared: string[][] = [];
  await runRootTypecheck({
    compilerOnly: true,
    runCommand: async ({ args }) => { ordinary.push([...args]); },
  });
  await runRootTypecheck({
    compilerOnly: true,
    preparedWorkspaces: true,
    runCommand: async ({ args }) => { prepared.push([...args]); },
  });

  assert.deepEqual(ordinary.slice(0, 1), [
    ['-s', 'prepare:typecheck:workspaces'],
  ]);
  assert.deepEqual(prepared, ordinary.slice(1));
  assert.ok(prepared.some((args) => args.includes('packages/protocol/tsconfig.json')));
  for (const workspace of ['apps/ui', 'apps/cli', 'apps/server', 'packages/tests']) {
    assert.deepEqual(prepared.filter((args) => args.includes(workspace)), [
      ['--cwd', workspace, '-s', 'typecheck'],
    ]);
  }
});

test('current-run prepared compiler mode still attempts every compiler and reports failures', async () => {
  const executed: string[] = [];
  await assert.rejects(runRootTypecheck({
    compilerOnly: true,
    preparedWorkspaces: true,
    runCommand: async ({ id }) => {
      executed.push(id);
      if (id === 'type-tests') throw new Error('Protocol rejected source');
      if (id === 'apps/ui/tsconfig.json') throw new Error('UI rejected source');
    },
  }), (error: unknown) => {
    assert.match(String(error), /Protocol rejected source/u);
    assert.match(String(error), /UI rejected source/u);
    return true;
  });
  assert.equal(executed[0], 'type-tests');
  assert.equal(executed.at(-1), 'packages/tests/tsconfig.json');
  assert.equal(executed.length, 10);
  assert.ok(!executed.includes('build-packages'));
  assert.ok(!executed.includes('prepare-workspaces'));
});

test('prepared workspaces are refused outside compiler-only mode before running anything', async () => {
  const executed: string[] = [];
  await assert.rejects(runRootTypecheck({
    preparedWorkspaces: true,
    runCommand: async ({ id }) => { executed.push(id); },
  }), /prepared workspaces require compiler-only mode/u);
  assert.deepEqual(executed, []);
});

test('prepared compiler partitions check every owner exactly once without a whole-suite replay', async () => {
  const complete: string[] = [];
  const ui: string[] = [];
  const host: string[] = [];
  for (const [compilerPartition, executed] of [[undefined, complete], ['ui', ui], ['host', host]] as const) {
    await runRootTypecheck({
      compilerOnly: true,
      preparedWorkspaces: true,
      compilerPartition,
      runCommand: async ({ id }) => { executed.push(id); },
    });
  }
  assert.deepEqual(ui, ['apps/ui/tsconfig.json']);
  assert.deepEqual(host, complete.filter((id) => id !== 'apps/ui/tsconfig.json'));
  assert.equal(new Set([...ui, ...host]).size, complete.length);
  assert.equal(ui.length + host.length, complete.length);
});

test('compiler partition selection is rejected outside compiler-only mode before execution', async () => {
  const executed: string[] = [];
  await assert.rejects(runRootTypecheck({
    compilerPartition: 'ui',
    runCommand: async ({ id }) => { executed.push(id); },
  }), /compiler partition requires compiler-only mode/u);
  assert.deepEqual(executed, []);
});

test('public compiler entry refuses malformed partition selection instead of loading every graph', () => {
  for (const argument of ['--compiler-partition=unknown', '--compiler-partition=', '--compiler-partition']) {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types', 'scripts/testing/runTypecheck.ts',
      '--compiler-only', '--prepared-workspaces', argument,
    ], { encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /compiler partition must be ui or host/u);
  }
});
