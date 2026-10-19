import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { withTempPathBin } from '../fs/withTempPathBin';
import { repoRootDir } from '../paths';
import { waitFor } from '../timing';
import { isProcessAlive, terminateProcessTreeByPid } from './processTree';

type WrapperCase = {
  name: string;
  scriptPath: string;
  toolCommandName: string;
  configName: string;
  buildArgs: (configPath: string) => string[];
  extraEnv?: Record<string, string>;
};

const WRAPPER_CASES: WrapperCase[] = [
  {
    name: 'run-vitest-with-heartbeat',
    scriptPath: 'packages/tests/scripts/run-vitest-with-heartbeat.mjs',
    toolCommandName: 'yarn',
    configName: 'vitest.config.ts',
    buildArgs: (configPath) => ['--config', configPath],
  },
  {
    name: 'run-playwright-with-heartbeat',
    scriptPath: 'packages/tests/scripts/run-playwright-with-heartbeat.mjs',
    toolCommandName: 'yarn',
    configName: 'playwright.config.mjs',
    buildArgs: (configPath) => ['--config', configPath],
  },
  {
    name: 'apps-ui-with-node-heap-limit',
    scriptPath: 'apps/ui/scripts/withNodeHeapLimit.mjs',
    toolCommandName: 'fake-runner',
    configName: 'noop.config',
    buildArgs: (configPath) => ['fake-runner', configPath],
  },
  {
    name: 'apps-ui-run-vitest-shards',
    scriptPath: 'apps/ui/scripts/runVitestShards.mjs',
    toolCommandName: 'vitest',
    configName: 'vitest.config.ts',
    buildArgs: (configPath) => ['--config', configPath],
    extraEnv: {
      HAPPIER_UI_VITEST_SHARDS: '1',
    },
  },
  {
    name: 'apps-cli-with-node-heap-limit',
    scriptPath: 'apps/cli/scripts/withNodeHeapLimit.mjs',
    toolCommandName: 'fake-runner',
    configName: 'noop.config',
    buildArgs: (configPath) => ['fake-runner', configPath],
  },
  {
    name: 'apps-cli-run-vitest-shards',
    scriptPath: 'apps/cli/scripts/runVitestShards.mjs',
    toolCommandName: 'vitest',
    configName: 'vitest.config.ts',
    buildArgs: (configPath) => ['--config', configPath],
    extraEnv: {
      HAPPIER_CLI_VITEST_SHARDS: '1',
    },
  },
];

function createChildProcessExitPromise(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: string | null }> {
  return once(child, 'exit').then(([code, signal]) => ({
    code: typeof code === 'number' ? code : null,
    signal: typeof signal === 'string' ? signal : null,
  }));
}

async function createFakeToolchain(
  toolDir: string,
  commandName: string,
  markerPath: string,
  opts?: Readonly<{ exitAfterSpawn?: boolean; signalAfterSpawn?: NodeJS.Signals }>,
): Promise<string> {
  const sharedScriptPath = join(toolDir, 'fake-yarn.cjs');
  const exitAfterSpawn = opts?.exitAfterSpawn === true;
  const signalAfterSpawn = opts?.signalAfterSpawn;

  await writeFile(
    sharedScriptPath,
    [
      "'use strict';",
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const markerPath = process.env.HAPPIER_HEARTBEAT_MARKER;",
      "if (!markerPath) throw new Error('Missing HAPPIER_HEARTBEAT_MARKER');",
      // Collection is a prerequisite, not the long-running process whose lifecycle is under test.
      "if (process.argv[2] === 'list') {",
      "  const jsonPath = process.argv[process.argv.indexOf('--json') + 1];",
      "  writeFileSync(jsonPath, JSON.stringify([{ file: 'fixture.test.ts' }]), 'utf8');",
      "  process.exit(0);",
      "}",
      "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "if (!grandchild.pid) throw new Error('Failed to spawn descendant process');",
      "writeFileSync(markerPath, JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid }), 'utf8');",
      signalAfterSpawn
        ? `setTimeout(() => process.kill(process.pid, ${JSON.stringify(signalAfterSpawn)}), 25);`
        : exitAfterSpawn
          ? 'process.exit(0);'
          : "setInterval(() => {}, 1000);",
      '',
    ].join('\n'),
    'utf8',
  );

  // Heartbeat wrappers use the canonical Corepack invocation rather than bare Yarn.
  for (const shim of commandName === 'yarn' ? ['yarn', 'corepack'] : [commandName]) {
    const commandPath = join(toolDir, process.platform === 'win32' ? `${shim}.cmd` : shim);
    if (process.platform === 'win32') {
      await writeFile(commandPath, `@echo off\r\nnode "${sharedScriptPath}" %*\r\n`, 'utf8');
    } else {
      await writeFile(commandPath, "#!/usr/bin/env node\nrequire('./fake-yarn.cjs');\n", 'utf8');
      await chmod(commandPath, 0o755);
    }
  }
  return sharedScriptPath;
}

async function resolveWrapperFixturePath(caseItem: WrapperCase, toolDir: string, toolScriptPath: string): Promise<string> {
  if (caseItem.name !== 'apps-ui-run-vitest-shards' && caseItem.name !== 'apps-cli-run-vitest-shards') {
    return resolve(repoRootDir(), caseItem.scriptPath);
  }

  // These wrappers resolve their Vitest executable from their own package, not PATH. Keep their
  // internal implementation real and replace only the external package in the fixture tree.
  const fixtureRoot = join(toolDir, 'workspace');
  const sources = [
    caseItem.scriptPath,
    join(dirname(caseItem.scriptPath), 'withNodeHeapLimit.mjs'),
    'scripts/testing/process/managedChildLifecycle.mjs',
    'scripts/testing/process/processTree.mjs',
    'scripts/testing/vitestNodeCommand.mjs',
    'scripts/testing/vitestShardCollection.mjs',
    'scripts/testing/vitestShardOutcomes.mjs',
    'scripts/testing/vitestWorkers.ts',
    'scripts/workspaces/execYarnCommand.mjs',
    'packages/cli-common/windowsCommandInvocation.mjs',
  ];
  await Promise.all(sources.map(async (source) => {
    const destination = join(fixtureRoot, source);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(repoRootDir(), source), destination);
  }));
  const vitestDir = join(fixtureRoot, 'node_modules', 'vitest');
  await mkdir(vitestDir, { recursive: true });
  await writeFile(join(vitestDir, 'package.json'), JSON.stringify({
    name: 'vitest', type: 'module', exports: { './vitest.mjs': './vitest.mjs', './node': './node.mjs' },
  }));
  await writeFile(join(vitestDir, 'vitest.mjs'), `import ${JSON.stringify(pathToFileURL(toolScriptPath).href)};\n`);
  // Retain Vitest's real argument parser; only its executable process is the OS boundary.
  const vitestNode = createRequire(import.meta.url).resolve('vitest/node');
  await writeFile(join(vitestDir, 'node.mjs'), `export { parseCLI } from ${JSON.stringify(pathToFileURL(vitestNode).href)};\n`);
  return join(fixtureRoot, caseItem.scriptPath);
}

async function runWrapperCleanupScenario(
  caseItem: WrapperCase,
  opts?: Readonly<{ exitAfterSpawn?: boolean; signalAfterSpawn?: NodeJS.Signals; wrapperTimeoutMs?: number }>,
): Promise<{
  exit: { code: number | null; signal: string | null };
  diagnostic: Array<Record<string, unknown>>;
}> {
  return await withTempPathBin({ prefix: `happier-heartbeat-${caseItem.name}-` }, async (tempPathBin) => {
    const toolDir = tempPathBin.dir;
    const markerPath = join(toolDir, 'process-marker.json');
    const diagnosticPath = join(toolDir, 'heartbeat-diagnostic.ndjson');
    const configPath = join(toolDir, caseItem.configName);
    const env = {
      ...tempPathBin.env,
      HAPPIER_HEARTBEAT_MARKER: markerPath,
      HAPPIER_CI_DIAGNOSTIC_PATH: diagnosticPath,
      HAPPIER_TEST_HEARTBEAT_MS: '1000',
      HAPPIER_TEST_WRAPPER_TIMEOUT_MS: opts?.wrapperTimeoutMs ? String(opts.wrapperTimeoutMs) : '',
      HAPPIER_HEARTBEAT_EXIT_AFTER_SPAWN: opts?.exitAfterSpawn === true ? '1' : '',
      ...caseItem.extraEnv,
    };

    await writeFile(configPath, '// test config\n', 'utf8');
    const toolScriptPath = await createFakeToolchain(toolDir, caseItem.toolCommandName, markerPath, opts);
    const wrapperPath = await resolveWrapperFixturePath(caseItem, toolDir, toolScriptPath);

    const child = spawn(process.execPath, [wrapperPath, ...caseItem.buildArgs(configPath)], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childOutput = '';
    child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
    child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });
    const childExitPromise = createChildProcessExitPromise(child);

    try {
      await waitFor(async () => {
        try {
          const raw = await readFile(markerPath, 'utf8');
          const parsed = JSON.parse(raw) as { childPid?: unknown; grandchildPid?: unknown };
          return Number.isInteger(parsed.childPid) && Number.isInteger(parsed.grandchildPid);
        } catch {
          if (child.exitCode !== null || child.signalCode !== null) {
            throw new Error(`${caseItem.name} exited before fixture startup (code=${child.exitCode}, signal=${child.signalCode}):\n${childOutput}`);
          }
          return false;
        }
      }, { timeoutMs: 20_000, intervalMs: 100, failFast: true, context: `${caseItem.name} fake yarn startup` });

      const raw = await readFile(markerPath, 'utf8');
      const marker = JSON.parse(raw) as { childPid: number; grandchildPid: number };
      expect(marker.childPid).toBeGreaterThan(0);
      expect(marker.grandchildPid).toBeGreaterThan(0);

      let exitResult: { code: number | null; signal: string | null } | null = null;

      if (opts?.wrapperTimeoutMs) {
        exitResult = await Promise.race([
          childExitPromise,
          new Promise<{ code: number | null; signal: string | null }>((_, reject) => {
            setTimeout(() => reject(new Error(`${caseItem.name} wrapper did not exit after timeout`)), 5_000);
          }),
        ]);
      } else if (opts?.exitAfterSpawn === true) {
        exitResult = await childExitPromise;
      } else if (opts?.signalAfterSpawn) {
        exitResult = await childExitPromise;
      } else {
        child.kill('SIGTERM');
        exitResult = await childExitPromise;
      }

      await waitFor(() => !isProcessAlive(marker.childPid), {
        timeoutMs: 10_000,
        intervalMs: 100,
        context: `${caseItem.name} wrapper child shutdown`,
      });

      await waitFor(() => !isProcessAlive(marker.grandchildPid), {
        timeoutMs: 10_000,
        intervalMs: 100,
        context: `${caseItem.name} wrapper descendant shutdown`,
      });

      const diagnostic = await readFile(diagnosticPath, 'utf8')
        .then((raw) => raw
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
      return { exit: exitResult!, diagnostic };
    } finally {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
      await terminateProcessTreeByPid(child.pid ?? 0, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
    }
  });
}

async function runWrapperParentExitCleanupScenario(caseItem: WrapperCase): Promise<void> {
  await withTempPathBin({ prefix: `happier-heartbeat-parent-exit-${caseItem.name}-` }, async (tempPathBin) => {
    const toolDir = tempPathBin.dir;
    const markerPath = join(toolDir, 'process-marker.json');
    const wrapperPidPath = join(toolDir, 'wrapper-pid.json');
    const configPath = join(toolDir, caseItem.configName);
    const launcherPath = join(toolDir, 'launcher.cjs');
    const env = {
      ...tempPathBin.env,
      HAPPIER_HEARTBEAT_MARKER: markerPath,
      HAPPIER_TEST_HEARTBEAT_MS: '1000',
      HAPPIER_WRAPPER_PID_PATH: wrapperPidPath,
      ...caseItem.extraEnv,
    };

    await writeFile(configPath, '// test config\n', 'utf8');
    const toolScriptPath = await createFakeToolchain(toolDir, caseItem.toolCommandName, markerPath);
    const wrapperPath = await resolveWrapperFixturePath(caseItem, toolDir, toolScriptPath);
    await writeFile(
      launcherPath,
      [
        "'use strict';",
        "const { spawn } = require('node:child_process');",
        "const { existsSync, writeFileSync } = require('node:fs');",
        "const wrapperPath = process.env.HAPPIER_WRAPPER_PATH;",
        "const wrapperPidPath = process.env.HAPPIER_WRAPPER_PID_PATH;",
        "const configPath = process.env.HAPPIER_WRAPPER_CONFIG;",
        "const rawWrapperArgs = process.env.HAPPIER_WRAPPER_ARGS_JSON;",
        "if (!wrapperPath || !wrapperPidPath || !configPath) throw new Error('Missing wrapper launcher env');",
        "const wrapperArgs = Array.isArray(JSON.parse(rawWrapperArgs || '[]')) ? JSON.parse(rawWrapperArgs || '[]') : [];",
        "const child = spawn(process.execPath, [wrapperPath, ...wrapperArgs], {",
        "  env: process.env,",
        "  stdio: 'ignore',",
        "});",
        "if (!child.pid) throw new Error('Failed to spawn wrapper');",
        "writeFileSync(wrapperPidPath, JSON.stringify({ wrapperPid: child.pid }), 'utf8');",
        "const deadline = Date.now() + 10000;",
        "const poll = () => {",
        "  if (existsSync(process.env.HAPPIER_HEARTBEAT_MARKER)) {",
        "    process.exit(0);",
        "    return;",
        "  }",
        "  if (Date.now() >= deadline) {",
        "    process.exit(2);",
        "    return;",
        "  }",
        "  setTimeout(poll, 50);",
        "};",
        "poll();",
        '',
      ].join('\n'),
      'utf8',
    );

    const launcher = spawn(process.execPath, [launcherPath], {
      env: {
        ...env,
        HAPPIER_WRAPPER_PATH: wrapperPath,
        HAPPIER_WRAPPER_CONFIG: configPath,
        HAPPIER_WRAPPER_ARGS_JSON: JSON.stringify(caseItem.buildArgs(configPath)),
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    let wrapperPid = 0;
    let marker: { childPid: number; grandchildPid: number } | null = null;
    try {
      await once(launcher, 'exit');

      await waitFor(async () => {
        try {
          const raw = await readFile(wrapperPidPath, 'utf8');
          const parsed = JSON.parse(raw) as { wrapperPid?: unknown };
          return Number.isInteger(parsed.wrapperPid);
        } catch {
          return false;
        }
      }, { timeoutMs: 10_000, intervalMs: 100, context: `${caseItem.name} wrapper pid capture` });

      const wrapperRaw = await readFile(wrapperPidPath, 'utf8');
      wrapperPid = (JSON.parse(wrapperRaw) as { wrapperPid: number }).wrapperPid;
      expect(wrapperPid).toBeGreaterThan(0);

      await waitFor(async () => {
        try {
          const raw = await readFile(markerPath, 'utf8');
          const parsed = JSON.parse(raw) as { childPid?: unknown; grandchildPid?: unknown };
          return Number.isInteger(parsed.childPid) && Number.isInteger(parsed.grandchildPid);
        } catch {
          return false;
        }
      }, { timeoutMs: 20_000, intervalMs: 100, context: `${caseItem.name} fake yarn startup before parent exit` });

      marker = JSON.parse(await readFile(markerPath, 'utf8')) as { childPid: number; grandchildPid: number };
      expect(marker.childPid).toBeGreaterThan(0);
      expect(marker.grandchildPid).toBeGreaterThan(0);

      await waitFor(() => !isProcessAlive(wrapperPid), {
        timeoutMs: 10_000,
        intervalMs: 100,
        context: `${caseItem.name} wrapper shutdown after parent exit`,
      });

      await waitFor(() => !isProcessAlive(marker!.childPid), {
        timeoutMs: 10_000,
        intervalMs: 100,
        context: `${caseItem.name} wrapper child shutdown after parent exit`,
      });

      await waitFor(() => !isProcessAlive(marker!.grandchildPid), {
        timeoutMs: 10_000,
        intervalMs: 100,
        context: `${caseItem.name} wrapper grandchild shutdown after parent exit`,
      });
    } finally {
      await terminateProcessTreeByPid(launcher.pid ?? 0, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
      if (wrapperPid > 0) {
        await terminateProcessTreeByPid(wrapperPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
      }
      if (marker?.childPid) {
        await terminateProcessTreeByPid(marker.childPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
      }
      if (marker?.grandchildPid) {
        await terminateProcessTreeByPid(marker.grandchildPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
      }
    }
  });
}

describe.each(WRAPPER_CASES)('%s', (caseItem) => {
  it('terminates descendant test processes when the wrapper receives SIGTERM', async () => {
    await runWrapperCleanupScenario(caseItem);
  }, 30_000);

  it('maps child signal exits to canonical shell exit codes', async () => {
    const result = await runWrapperCleanupScenario(caseItem, { signalAfterSpawn: 'SIGTERM' });
    expect(result.exit).toEqual({ code: 143, signal: null });
  }, 30_000);

  it('terminates descendant test processes when the child exits successfully', async () => {
    await runWrapperCleanupScenario(caseItem, { exitAfterSpawn: true });
  }, 30_000);

  it('terminates descendant test processes when the wrapper loses its parent', async () => {
    await runWrapperParentExitCleanupScenario(caseItem);
  }, 30_000);
});

describe('run-playwright-with-heartbeat timeout cleanup', () => {
  it('terminates descendant test processes when the wrapper runtime timeout elapses', async () => {
    const caseItem = WRAPPER_CASES.find((item) => item.name === 'run-playwright-with-heartbeat');
    expect(caseItem).toBeDefined();

    const result = await runWrapperCleanupScenario(caseItem!, { wrapperTimeoutMs: 2_000 });

    expect(result.exit).toEqual({ code: 124, signal: null });
  }, 30_000);

  it('sweeps stale process ownership leases after completion', async () => {
    const caseItem = WRAPPER_CASES.find((item) => item.name === 'run-playwright-with-heartbeat');
    expect(caseItem).toBeDefined();

    const wrapperPath = resolve(repoRootDir(), caseItem!.scriptPath);

    await withTempPathBin({ prefix: 'happier-heartbeat-lease-sweep-' }, async (tempPathBin) => {
      const rootDir = tempPathBin.dir;
      const leaseDir = resolve(rootDir, '.project', 'tmp', 'ui-web-metro-processes');
      mkdirSync(leaseDir, { recursive: true });

      // Spawn a long-running child that looks like an Expo web dev server.
      const orphan = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000)',
        'start',
        '--web',
        '--host',
        'localhost',
      ], { stdio: 'ignore' });
      if (!orphan.pid) throw new Error('failed to spawn orphan process');

      const childPid = orphan.pid;
      const childStartTimeRes = spawnSync('ps', ['-o', 'lstart=', '-p', String(childPid), '-ww'], { encoding: 'utf8' });
      const childStartTime = String(childStartTimeRes.stdout ?? '').trim();
      expect(childStartTime.length).toBeGreaterThan(0);

      // Use a PID that will definitely be dead by the time the wrapper performs the sweep.
      const deadOwner = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { encoding: 'utf8' });
      const ownerPid = deadOwner.pid ?? 999999;

      writeFileSync(resolve(leaseDir, `pid-${childPid}.json`), JSON.stringify({
        childPid,
        childStartTime,
        ownerPid,
        ownerStartTime: 'dead',
        createdAtMs: Date.now(),
        metadata: { port: 0, testDir: rootDir },
      }), 'utf8');

      try {
        const markerPath = join(rootDir, 'process-marker.json');
        const configPath = join(rootDir, 'playwright.config.mjs');
        await writeFile(configPath, '// test config\n', 'utf8');
        await createFakeToolchain(rootDir, caseItem!.toolCommandName, markerPath);

        const child = spawn(process.execPath, [wrapperPath, '--config', configPath], {
          env: {
            ...tempPathBin.env,
            HAPPIER_TEST_PROCESS_LEASE_ROOT_DIR: rootDir,
            HAPPIER_HEARTBEAT_MARKER: markerPath,
            HAPPIER_TEST_HEARTBEAT_MS: '1000',
            HAPPIER_TEST_WRAPPER_TIMEOUT_MS: '250',
          },
          stdio: ['ignore', 'ignore', 'ignore'],
        });

        const { code } = await once(child, 'exit').then(([exitCode]) => ({ code: exitCode as number | null }));
        expect(code).toBe(124);

        await waitFor(() => !isProcessAlive(childPid), {
          timeoutMs: 10_000,
          intervalMs: 100,
          context: 'orphan metro lease process should be terminated by wrapper sweep',
        });
      } finally {
        await terminateProcessTreeByPid(childPid, { graceMs: 0, pollMs: 25, skipAliveCheck: true }).catch(() => {});
      }
    });
  }, 30_000);
});

describe('heartbeat diagnostics', () => {
  it('records when the heartbeat wrapper itself receives a process signal', async () => {
    const result = await runWrapperCleanupScenario(WRAPPER_CASES[0]!);
    expect(result.diagnostic).toContainEqual(expect.objectContaining({
      event: 'process-signal',
      signal: 'SIGTERM',
    }));
  }, 30_000);

  it('records the exact Vitest test case that ran before exit', async () => {
    const wrapperPath = resolve(repoRootDir(), 'packages/tests/scripts/run-vitest-with-heartbeat.mjs');

    await withTempPathBin({ prefix: 'happier-vitest-case-diagnostic-' }, async (tempPathBin) => {
      const configPath = join(tempPathBin.dir, 'vitest.config.mjs');
      const testPath = join(tempPathBin.dir, 'diagnostic.test.js');
      const diagnosticPath = join(tempPathBin.dir, 'vitest-heartbeat-diagnostic.ndjson');
      await writeFile(
        configPath,
        `export default { test: { root: ${JSON.stringify(tempPathBin.dir)}, globals: true, include: ['diagnostic.test.js'] } };\n`,
        'utf8',
      );
      await writeFile(testPath, "test('diagnostic fixture', () => expect(true).toBe(true));\n", 'utf8');

      const child = spawn(process.execPath, [wrapperPath, '--config', configPath], {
        env: {
          ...tempPathBin.env,
          HAPPIER_CI_DIAGNOSTIC_PATH: diagnosticPath,
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      expect(await createChildProcessExitPromise(child)).toEqual({ code: 0, signal: null });

      const diagnostic = (await readFile(diagnosticPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { event?: unknown; moduleId?: unknown; testName?: unknown });
      expect(diagnostic).toContainEqual(expect.objectContaining({
        event: 'test-case-ready',
        moduleId: testPath,
        testName: 'diagnostic fixture',
      }));
      expect(diagnostic).toContainEqual(expect.objectContaining({
        event: 'test-case-result',
        moduleId: testPath,
        testName: 'diagnostic fixture',
      }));
    });
  }, 30_000);
});
