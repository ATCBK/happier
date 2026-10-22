import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    'node scripts/runWithHeartbeat.mjs --label typecheck -- pnpm --silent run typecheck:inner',
  );
});

test('root typecheck plan preserves prerequisite order and every Turbo workspace owner', () => {
  assert.deepEqual(ROOT_TYPECHECK_COMMANDS.map((command) => command.args), [
    ['run', '--silent', 'prepare:typecheck:workspaces'],
    [
      'exec', 'turbo',
      'run',
      'typecheck:finite',
      '--continue=always',
      '--filter=@happier-dev/plugin-sdk',
      '--filter=@happier-dev/sdk',
    ],
    [
      'exec', 'turbo',
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
      'run', 'tsc', '--noEmit',
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
  assert.deepEqual(uiCommands, [['--dir', 'apps/ui', 'run', '--silent', 'typecheck']]);
  const cliCommands = executed.filter((args) => args.includes('apps/cli'));
  assert.deepEqual(cliCommands, [['--dir', 'apps/cli', 'run', '--silent', 'typecheck']]);
  const serverCommands = executed.filter((args) => args.includes('apps/server'));
  assert.deepEqual(serverCommands, [['--dir', 'apps/server', 'run', '--silent', 'typecheck']],
    'server compilation must use the package owner that prepares generated Prisma clients');
  const testsCommands = executed.filter((args) => args.includes('packages/tests'));
  assert.deepEqual(testsCommands, [['--dir', 'packages/tests', 'run', '--silent', 'typecheck']]);
  const uiPackage = JSON.parse(readFileSync('apps/ui/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(uiPackage.scripts.typecheck, '../stack/bin/hstack-exec --script=typecheck:local');
  assert.equal(uiPackage.scripts['typecheck:local'], 'pnpm --silent run typecheck:source:finite');
  const [executable, owner, ...compilerArgs] = uiPackage.scripts['typecheck:source:finite'].trim().split(/\s+/u);
  assert.equal(executable, 'node');
  assert.equal(resolve('apps/ui', owner), resolve('scripts/workspaces/runTypeScriptCli.mjs'));
  assert.deepEqual(compilerArgs.filter((_, index) => compilerArgs[index - 1] === '--project'), [
    'tsconfig.foundation.json', 'tsconfig.core.json', 'tsconfig.source.json',
    'tsconfig.test-components.json', 'tsconfig.test-other.json',
  ]);
  for (const args of executed.slice(1)) {
    if (!uiCommands.includes(args) && !cliCommands.includes(args) && !serverCommands.includes(args) && !testsCommands.includes(args)) {
      assert.deepEqual(args.slice(0, 2), ['run', 'tsc']);
      assert.ok(args.includes('--noEmit'));
    }
  }
  assert.ok(executed.some((args) => args.includes('packages/protocol/tsconfig.json')));
  assert.ok(executed.some((args) => args.includes('packages/plugins/triage/tsconfig.json')));
  const cliPackage = JSON.parse(readFileSync('apps/cli/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(cliPackage.scripts.typecheck, '../stack/bin/hstack-exec --script=typecheck:local');
  assert.equal(cliPackage.scripts['typecheck:local'], 'pnpm --silent run typecheck:source:finite');
  const [cliExecutable, cliOwner, ...cliCompilerArgs] = cliPackage.scripts['typecheck:source:finite'].trim().split(/\s+/u);
  assert.equal(cliExecutable, 'node');
  assert.equal(resolve('apps/cli', cliOwner), resolve('scripts/workspaces/runTypeScriptCli.mjs'));
  assert.deepEqual(cliCompilerArgs.filter((_, index) => cliCompilerArgs[index - 1] === '--project'), [
    'tsconfig.foundation.json', 'tsconfig.services.json', 'tsconfig.core.json', 'tsconfig.source.json', 'tsconfig.test.json',
    'tsconfig.test-ui.json',
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
    ['run', '--silent', 'prepare:typecheck:workspaces'],
  ]);
  assert.deepEqual(prepared, ordinary.slice(1));
  assert.ok(prepared.some((args) => args.includes('packages/protocol/tsconfig.json')));
  for (const workspace of ['apps/ui', 'apps/cli', 'apps/server', 'packages/tests']) {
    assert.deepEqual(prepared.filter((args) => args.includes(workspace)), [
      ['--dir', workspace, 'run', '--silent', 'typecheck'],
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

function compilerBaselineFixture(t: test.TestContext) {
  const rootDir = mkdtempSync(resolve(tmpdir(), 'happier-compiler-baseline-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  mkdirSync(resolve(rootDir, 'apps/ui'), { recursive: true });
  writeFileSync(resolve(rootDir, 'apps/ui/source.ts'), 'export const value: string = 1;\n');
  git('init', '-q');
  git('add', 'apps/ui/source.ts');
  git('-c', 'user.name=Compiler fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test source');
  const sourceCommit = git('rev-parse', 'HEAD');
  const baselinePath = 'compiler-baseline.json';
  const diagnostic = { package: 'apps/ui', file: 'apps/ui/source.ts', line: 1, column: 14, code: 2322, message: "Type 'number' is not assignable to type 'string'." };
  const baseline = { sourceCommit, diagnostics: [diagnostic] };
  writeFileSync(resolve(rootDir, baselinePath), JSON.stringify(baseline));
  git('add', baselinePath);
  git('-c', 'user.name=Compiler fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test baseline');
  const baselineBaseRef = git('rev-parse', 'HEAD');
  const options = { rootDir, compilerOnly: true, preparedWorkspaces: true, baselinePath, baselineBaseRef, commands: [{ id: 'apps/ui/tsconfig.json', args: ['--cwd', 'apps/ui', '-s', 'typecheck'] }] } as const;
  const runCommand = async (_command: unknown, env: NodeJS.ProcessEnv = {}) => {
    assert.ok(env.HAPPIER_TYPECHECK_REPORT_DIR, 'the real compiler receives the diagnostic report path');
    writeFileSync(resolve(env.HAPPIER_TYPECHECK_REPORT_DIR, 'result.json'), JSON.stringify({
      cwd: resolve(rootDir, 'apps/ui'), project: 'tsconfig.json', status: 1, signal: null, stderr: '',
      stdout: `source.ts(1,14): error TS2322: ${diagnostic.message}\n`,
    }));
    throw Object.assign(new Error('exited with status 1'), { exitCode: 1, signal: null });
  };
  return { rootDir, baselinePath, options, baseline, runCommand };
}

test('compiler baseline runs the native report through the gate and rejects additions against Git base', async (t) => {
  const fixture = compilerBaselineFixture(t);
  await runRootTypecheck({ ...fixture.options, baselineMode: 'check', runCommand: fixture.runCommand });
  writeFileSync(resolve(fixture.rootDir, fixture.baselinePath), JSON.stringify({ ...fixture.baseline, diagnostics: [...fixture.baseline.diagnostics, ...fixture.baseline.diagnostics] }));
  await assert.rejects(runRootTypecheck({ ...fixture.options, baselineMode: 'check', runCommand: fixture.runCommand }), /baseline increase rejected/u);
});

test('regular compiler refresh removes resolved rows and the same error cannot be reintroduced', async (t) => {
  const fixture = compilerBaselineFixture(t);
  const cleanCompiler = async (_command: unknown, env: NodeJS.ProcessEnv = {}) => {
    assert.ok(env.HAPPIER_TYPECHECK_REPORT_DIR);
    writeFileSync(resolve(env.HAPPIER_TYPECHECK_REPORT_DIR, 'result.json'), JSON.stringify({ cwd: resolve(fixture.rootDir, 'apps/ui'), project: 'tsconfig.json', status: 0, signal: null, stdout: '', stderr: '' }));
  };
  await assert.rejects(runRootTypecheck({ ...fixture.options, baselineMode: 'check', runCommand: cleanCompiler }), /refresh/u);
  await runRootTypecheck({ ...fixture.options, baselineMode: 'refresh', runCommand: cleanCompiler });
  assert.deepEqual(JSON.parse(readFileSync(resolve(fixture.rootDir, fixture.baselinePath), 'utf8')).diagnostics, []);
  await assert.rejects(runRootTypecheck({ ...fixture.options, baselineMode: 'check', runCommand: fixture.runCommand }), /new compiler diagnostics/u);
});

test('compiler baseline rejects a crash after otherwise covered diagnostics', async (t) => {
  const fixture = compilerBaselineFixture(t);
  const crashed = async (command: unknown, env: NodeJS.ProcessEnv = {}) => {
    try { await fixture.runCommand(command, env); } catch { /* Replace only the OS terminal result. */ }
    assert.ok(env.HAPPIER_TYPECHECK_REPORT_DIR);
    const result = resolve(env.HAPPIER_TYPECHECK_REPORT_DIR, 'result.json');
    writeFileSync(result, JSON.stringify({ ...JSON.parse(readFileSync(result, 'utf8')), status: null, signal: 'SIGKILL' }));
    throw Object.assign(new Error('exited with status 137'), { exitCode: 137, signal: null });
  };
  await assert.rejects(runRootTypecheck({ ...fixture.options, baselineMode: 'check', runCommand: crashed }), /complete diagnostic result/u);
});
