import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it, vi } from 'vitest';
import { withTempDir } from '../../src/testkit/fs/tempDir';
import { spawnTestProcess } from '../../src/testkit/process/spawn';
import { resolveVitestNodeCommand } from '../../../../scripts/testing/vitestNodeCommand.mjs';

import {
  buildVitestListArgs,
  buildVitestShardArgs,
  resolveCliVitestLaneAdmission,
  resolveVitestConfigPath,
  resolveVitestForwardArgs,
  resolveVitestShardCount,
  resolveVitestShardRange,
  runCliVitestShardRuns,
} from '../runVitestShards.mjs';

const vitestEntrypoint = resolveVitestNodeCommand(fileURLToPath(new URL('../..', import.meta.url))).argsPrefix[0];

function readManagedChildArgs(input: Readonly<{ args?: readonly string[] }>) {
  const args = input.args ?? [];
  return args[0] === vitestEntrypoint ? args.slice(1) : args;
}

const { runManagedChildCommandMock } = vi.hoisted(() => ({
  // The lane collection pass runs `vitest list --filesOnly --json <path>` before any
  // shard, so this stands in for the real writer rather than leaving the file absent.
  runManagedChildCommandMock: vi.fn(async (input: Readonly<{ args?: readonly string[] }>) => {
    const args = readManagedChildArgs(input);
    const jsonIndex = args.indexOf('--json');
    if (args[0] === 'list' && jsonIndex !== -1 && typeof args[jsonIndex + 1] === 'string') {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        args[jsonIndex + 1]!,
        JSON.stringify([{ file: 'src/backends/catalog.runtimeAdapterConsumption.integration.test.ts' }]),
        'utf8',
      );
    }
    return { ok: true as const, code: 0, signal: null as null };
  }),
}));

vi.mock('../../../../scripts/testing/process/managedChildLifecycle.mjs', () => ({
  resolveSignalExitCode: vi.fn(() => 0),
  runManagedChildCommand: runManagedChildCommandMock,
}));

describe('runVitestShards', () => {
  it('runs the selected real Vitest file without a package-manager PATH', async () => {
    await withTempDir('happier-cli-vitest-executable-', async directory => {
      const emptyBin = join(directory, 'empty-bin');
      const config = join(directory, 'vitest.config.mjs');
      const marker = join(directory, 'selected-ran');
      await mkdir(emptyBin);
      await writeFile(config, `export default { root: ${JSON.stringify(directory)}, test: { globals: true, include: ['*.test.mjs'] } };\n`);
      await writeFile(join(directory, 'selected.test.mjs'), `import { writeFileSync } from 'node:fs';\ntest('package-owned executable', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); expect(2 + 2).toBe(4); });\n`);
      await writeFile(join(directory, 'outside.test.mjs'), "test('must remain unselected', () => { throw new Error('The runner widened its selected scope'); });\n");
      const child = spawnTestProcess(process.execPath, [
        fileURLToPath(new URL('../runVitestShards.mjs', import.meta.url)),
        '--config', config, '--unit-checks', '--', 'selected.test.mjs',
      ], {
        cwd: directory,
        // This child OS environment deliberately has no package-manager bins.
        // The importing package, not an ambient/global Vitest, owns the tool.
        env: { ...process.env, PATH: emptyBin },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout?.on('data', chunk => { output += chunk.toString(); });
      child.stderr?.on('data', chunk => { output += chunk.toString(); });
      try {
        const [code, signal] = await once(child, 'close');
        const plainOutput = stripVTControlCharacters(output);
        expect({ code, signal }, plainOutput).toEqual({ code: 0, signal: null });
        expect(await readFile(marker, 'utf8')).toBe('ran');
        expect(plainOutput).toMatch(/Test Files\s+1 passed/);
        expect(plainOutput).toMatch(/Tests\s+1 passed/);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await once(child, 'close');
        }
      }
    });
  });

  it('retains the eight-shard default when no unit configuration is supplied', () => {
    expect(resolveVitestShardCount({})).toBe(8);
  });

  it('runs the whole unit configuration once while retaining the integration default', () => {
    expect(resolveVitestShardCount({}, 'vitest.config.ts')).toBe(1);
    expect(resolveVitestShardCount({}, 'vitest.integration.config.ts')).toBe(8);
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '4' }, 'vitest.config.ts')).toBe(4);
  });

  it('assigns one native unit shard to each valid nightly part', () => {
    const env = { HAPPIER_CLI_VITEST_PART: '1', HAPPIER_CLI_VITEST_PARTS: '2' };
    const count = resolveVitestShardCount(env, 'vitest.config.ts');
    expect(count).toBe(2);
    expect(resolveVitestShardRange(env, count)).toEqual({ start: 1, end: 1, part: 1, parts: 2 });
    expect(resolveVitestShardRange({ ...env, HAPPIER_CLI_VITEST_PART: '2' }, count))
      .toEqual({ start: 2, end: 2, part: 2, parts: 2 });
  });

  it('uses HAPPIER_CLI_VITEST_SHARDS override when valid', () => {
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '4' })).toBe(4);
  });

  it('ignores invalid shard overrides', () => {
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '0' })).toBe(8);
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: 'nope' })).toBe(8);
  });

  it('partitions the configured shard count into balanced CI parts', () => {
    expect(resolveVitestShardRange({ HAPPIER_CLI_VITEST_PART: '1', HAPPIER_CLI_VITEST_PARTS: '2' }, 8))
      .toEqual({ start: 1, end: 4, part: 1, parts: 2 });
    expect(resolveVitestShardRange({ HAPPIER_CLI_VITEST_PART: '2', HAPPIER_CLI_VITEST_PARTS: '2' }, 8))
      .toEqual({ start: 5, end: 8, part: 2, parts: 2 });
    expect(resolveVitestShardRange({}, 8)).toEqual({ start: 1, end: 8, part: 1, parts: 1 });
  });

  it('lets an empty shard exit cleanly without making a hand-selected empty run green', () => {
    // `--shard N/M` legitimately yields empty shards, so the shard runner asks
    // for `--passWithNoTests` itself. It must NOT live in the config, or a
    // directly invoked selected pattern that collects nothing (CI does this at
    // .github/workflows/tests.yml for src/daemon/daemon.integration.test.ts)
    // would exit green after the file is renamed or moved.
    expect(buildVitestShardArgs({
      configPath: 'vitest.integration.config.ts',
      shardSpec: '2/8',
      vitestArgs: ['--testTimeout', '15000'],
    })).toEqual([
      'run',
      '--config',
      'vitest.integration.config.ts',
      '--testTimeout',
      '15000',
      '--passWithNoTests',
      '--shard',
      '2/8',
    ]);
  });

  it('parses --config path from argv', () => {
    expect(resolveVitestConfigPath(['node', 'run', '--config', 'vitest.integration.config.ts'])).toBe(
      'vitest.integration.config.ts',
    );
  });

  it('returns null when --config is missing', () => {
    expect(resolveVitestConfigPath(['node', 'run'])).toBe(null);
  });

  it('preserves file and name filters on either side of the runner config', () => {
    expect(resolveVitestForwardArgs(['node', 'runner', 'src/api/artifacts/accountArtifactStore.test.ts', '--config', 'vitest.config.ts', '-t', 'plain'])).toEqual([
      'src/api/artifacts/accountArtifactStore.test.ts', '-t', 'plain',
    ]);
  });

  it('runs every later shard after an earlier shard fails', async () => {
    const runShard = vi.fn()
      .mockResolvedValueOnce({ ok: true, code: 1, signal: null })
      .mockResolvedValueOnce({ ok: true, code: 0, signal: null })
      .mockResolvedValueOnce({ ok: true, code: 1, signal: null });

    const outcomes = await runCliVitestShardRuns({ shardCount: 3, runShard });

    expect(runShard.mock.calls.map(([entry]) => entry.shardSpec)).toEqual(['1/3', '2/3', '3/3']);
    expect(outcomes.map((entry) => entry.outcome)).toEqual(['failed', 'passed', 'failed']);
  });

  it('runs only the assigned absolute shard range', async () => {
    const runShard = vi.fn().mockResolvedValue({ ok: true, code: 0, signal: null });
    const outcomes = await runCliVitestShardRuns({ shardCount: 8, startShard: 5, endShard: 8, runShard });
    expect(runShard.mock.calls.map(([entry]) => entry.shardSpec)).toEqual(['5/8', '6/8', '7/8', '8/8']);
    expect(outcomes.map((entry) => entry.shardSpec)).toEqual(['5/8', '6/8', '7/8', '8/8']);
  });

  it('runs a selected file once without shard empty-collection tolerance', async () => {
    const prevArgv = process.argv.slice();
    const prevShardCount = process.env.HAPPIER_CLI_VITEST_SHARDS;

    try {
      process.env.HAPPIER_CLI_VITEST_SHARDS = '8';
      runManagedChildCommandMock.mockClear();
      process.argv = [
        'node',
        fileURLToPath(new URL('../runVitestShards.mjs', import.meta.url)),
        '--config',
        'vitest.integration.config.ts',
        '--unit-checks',
        'src/backends/catalog.runtimeAdapterConsumption.integration.test.ts',
      ];

      vi.resetModules();
      await import('../runVitestShards.mjs');

      // Module entry starts the real runner through its process boundary.
      await vi.waitFor(() => {
        expect(runManagedChildCommandMock.mock.calls.map(([input]) => readManagedChildArgs(input))).toContainEqual(
          ['run', '--config', 'vitest.integration.config.ts', 'src/backends/catalog.runtimeAdapterConsumption.integration.test.ts'],
        );
      });
      expect(runManagedChildCommandMock.mock.calls.filter(([input]) => readManagedChildArgs(input)[0] === 'run')).toHaveLength(1);
    } finally {
      process.argv = prevArgv;
      if (prevShardCount === undefined) delete process.env.HAPPIER_CLI_VITEST_SHARDS;
      else process.env.HAPPIER_CLI_VITEST_SHARDS = prevShardCount;
    }
  });

  it('keeps the native checks and import-cycle guard after an unfiltered unit suite', async () => {
    const prevArgv = process.argv.slice();
    const prevShardCount = process.env.HAPPIER_CLI_VITEST_SHARDS;
    try {
      runManagedChildCommandMock.mockClear();
      process.env.HAPPIER_CLI_VITEST_SHARDS = '2';
      process.argv = ['node', fileURLToPath(new URL('../runVitestShards.mjs', import.meta.url)), '--config', 'vitest.config.ts', '--unit-checks'];
      vi.resetModules();
      await import('../runVitestShards.mjs');
      await vi.waitFor(() => {
        expect(runManagedChildCommandMock.mock.calls.map(([input]) => readManagedChildArgs(input))).toContainEqual(
          expect.arrayContaining(['-s', 'test:import-cycles']),
        );
      });
      const calls = runManagedChildCommandMock.mock.calls.map(([input]) => readManagedChildArgs(input));
      expect(calls.filter(args => args[0] === 'run').map(args => args.at(-1))).toEqual(['1/2', '2/2']);
      expect(calls).toContainEqual(['--test', 'scripts/prepack-script.test.mjs', 'scripts/stageManagedRuntimeArchives.test.mjs', 'scripts/runWorkspaceSyncRealIntegration.test.mjs', 'scripts/__tests__/daemonStartupImportBoundary.test.mjs']);
    } finally {
      process.argv = prevArgv;
      if (prevShardCount === undefined) delete process.env.HAPPIER_CLI_VITEST_SHARDS;
      else process.env.HAPPIER_CLI_VITEST_SHARDS = prevShardCount;
    }
  });

  it('starts one unfiltered unit process without empty tolerance and retains its post-suite checks', async () => {
    const prevArgv = process.argv.slice();
    const envKeys = ['HAPPIER_CLI_VITEST_SHARDS', 'HAPPIER_CLI_VITEST_PART', 'HAPPIER_CLI_VITEST_PARTS'] as const;
    const previous = envKeys.map(key => process.env[key]);
    try {
      for (const key of envKeys) delete process.env[key];
      runManagedChildCommandMock.mockClear();
      process.argv = ['node', fileURLToPath(new URL('../runVitestShards.mjs', import.meta.url)), '--config', 'vitest.config.ts', '--unit-checks'];
      vi.resetModules();
      await import('../runVitestShards.mjs');
      await vi.waitFor(() => {
        expect(runManagedChildCommandMock.mock.calls.map(([input]) => readManagedChildArgs(input))).toContainEqual(
          expect.arrayContaining(['-s', 'test:import-cycles']),
        );
      });
      const calls = runManagedChildCommandMock.mock.calls.map(([input]) => readManagedChildArgs(input));
      expect(calls.filter(args => args[0] === 'list')).toHaveLength(0);
      expect(calls.filter(args => args[0] === 'run')).toEqual([['run', '--config', 'vitest.config.ts']]);
      expect(calls).toContainEqual(['--test', 'scripts/prepack-script.test.mjs', 'scripts/stageManagedRuntimeArchives.test.mjs', 'scripts/runWorkspaceSyncRealIntegration.test.mjs', 'scripts/__tests__/daemonStartupImportBoundary.test.mjs']);
    } finally {
      process.argv = prevArgv;
      envKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });

  it.each(['1', '2'])('executes only native partition %s/2 with no repeated collection or empty tolerance', async (part) => {
    const prevArgv = process.argv.slice();
    const envKeys = ['HAPPIER_CLI_VITEST_SHARDS', 'HAPPIER_CLI_VITEST_PART', 'HAPPIER_CLI_VITEST_PARTS'] as const;
    const previous = envKeys.map(key => process.env[key]);
    try {
      delete process.env.HAPPIER_CLI_VITEST_SHARDS;
      process.env.HAPPIER_CLI_VITEST_PART = part;
      process.env.HAPPIER_CLI_VITEST_PARTS = '2';
      runManagedChildCommandMock.mockClear();
      process.argv = ['node', fileURLToPath(new URL('../runVitestShards.mjs', import.meta.url)), '--config', 'vitest.config.ts', '--unit-checks'];
      vi.resetModules();
      await import('../runVitestShards.mjs');
      await vi.waitFor(() => {
        expect(runManagedChildCommandMock.mock.calls.map(([input]) => readManagedChildArgs(input))).toContainEqual(
          expect.arrayContaining(['-s', 'test:import-cycles']),
        );
      });
      const calls = runManagedChildCommandMock.mock.calls.map(([input]) => readManagedChildArgs(input));
      expect(calls.filter(args => args[0] === 'list')).toHaveLength(0);
      expect(calls.filter(args => args[0] === 'run')).toEqual([['run', '--config', 'vitest.config.ts', '--shard', `${part}/2`]]);
    } finally {
      process.argv = prevArgv;
      envKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });

  it('retains a failed empty unit result and does not enter the post-suite checks', async () => {
    const prevArgv = process.argv.slice();
    const prevExitCode = process.exitCode;
    const envKeys = ['HAPPIER_CLI_VITEST_SHARDS', 'HAPPIER_CLI_VITEST_PART', 'HAPPIER_CLI_VITEST_PARTS'] as const;
    const previous = envKeys.map(key => process.env[key]);
    const defaultBoundary = runManagedChildCommandMock.getMockImplementation()!;
    try {
      for (const key of envKeys) delete process.env[key];
      process.exitCode = undefined;
      runManagedChildCommandMock.mockClear();
      // Vitest is the subprocess boundary: an empty run exits 1 without passWithNoTests.
      runManagedChildCommandMock.mockImplementation(async input => readManagedChildArgs(input)[0] === 'run'
        ? { ok: true, code: 1, signal: null }
        : await defaultBoundary(input));
      process.argv = ['node', fileURLToPath(new URL('../runVitestShards.mjs', import.meta.url)), '--config', 'vitest.config.ts', '--unit-checks'];
      vi.resetModules();
      await import('../runVitestShards.mjs');
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      const calls = runManagedChildCommandMock.mock.calls.map(([input]) => readManagedChildArgs(input));
      expect(calls).toEqual([['run', '--config', 'vitest.config.ts']]);
    } finally {
      runManagedChildCommandMock.mockImplementation(defaultBoundary);
      process.argv = prevArgv;
      process.exitCode = prevExitCode;
      envKeys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    }
  });

  it('refuses to report a sharded lane green when the whole lane collected nothing', async () => {
    // Every shard asks for `--passWithNoTests` because `--shard N/M` legitimately
    // produces empty shards. Keeping the flag out of the lane config only protects a
    // direct `vitest run`; the sharded lane CI actually runs
    // (.github/workflows/tests.yml `yarn workspace @happier-dev/cli test:integration`)
    // still printed `8 shard(s) ran of 8: 8 passed` and exited 0 for zero collected
    // tests. The lane-level collection question is the one no single shard can answer.
    await expect(resolveCliVitestLaneAdmission({
      configPath: 'vitest.integration.config.ts',
      nodeOptions: '',
      vitestArgs: ['src/typo-that-matches-nothing'],
      listTestFiles: async () => [],
    })).resolves.toEqual({ admitted: false, fileCount: 0 });
  });

  it('admits an explicitly requested empty lane and any lane that collected files', async () => {
    await expect(resolveCliVitestLaneAdmission({
      configPath: 'vitest.integration.config.ts',
      nodeOptions: '',
      vitestArgs: ['--passWithNoTests'],
      listTestFiles: async () => [],
    })).resolves.toEqual({ admitted: true, fileCount: 0 });

    await expect(resolveCliVitestLaneAdmission({
      configPath: 'vitest.integration.config.ts',
      nodeOptions: '',
      vitestArgs: [],
      listTestFiles: async () => ['src/a.integration.test.ts'],
    })).resolves.toEqual({ admitted: true, fileCount: 1 });
  });

  it('collects the lane through the same config and caller filters the shards use', () => {
    expect(buildVitestListArgs({
      configPath: 'vitest.integration.config.ts',
      vitestArgs: ['src/daemon'],
      jsonPath: '/tmp/happier-cli-vitest-list/files.json',
    })).toEqual([
      'list',
      '--config',
      'vitest.integration.config.ts',
      'src/daemon',
      '--filesOnly',
      '--json',
      '/tmp/happier-cli-vitest-list/files.json',
    ]);
  });
});
