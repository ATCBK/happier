import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runCommandSuite, type CommandSuiteEntry } from './lib/runCommandSuite.ts';
import { runPnpmCommand } from './lib/runPnpmCommand.ts';
import { assertCompilerBaselineDoesNotIncrease, compareCompilerBaseline, compilerReportPackage, diagnosticsFromCompilerReport, mapUnchangedLine, parseCompilerBaseline } from './lib/compilerBaseline.mjs';
import { writeJsonAtomic } from '../../apps/stack/scripts/utils/fs/json.mjs';

const DEFAULT_BASELINE_PATH = 'scripts/testing/compiler-baseline.json';

async function gitOutput(rootDir: string, args: readonly string[]): Promise<string> {
  const child = spawn('git', [...args], { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
  return await new Promise((resolveOutput, rejectOutput) => {
    child.once('error', rejectOutput);
    child.once('close', (status, signal) => {
      if (status !== 0 || signal) rejectOutput(new Error(`compiler baseline Git query failed: ${Buffer.concat(stderr).toString().trim()}`));
      else resolveOutput(Buffer.concat(stdout).toString());
    });
  });
}

async function runBaselineCompilerSuite(rootDir: string, commands: readonly CommandSuiteEntry[], options: RunRootTypecheckOptions) {
  const path = resolve(rootDir, options.baselinePath ?? DEFAULT_BASELINE_PATH);
  const baselinePath = relative(rootDir, path).replaceAll('\\', '/');
  if (baselinePath.startsWith('../') || baselinePath === '..') throw new Error('compiler baseline must be inside the repository');
  const initialize = options.baselineMode === 'initialize';
  if (initialize && options.compilerPartition) throw new Error('compiler baseline initialization requires the complete compiler suite');
  let baseline;
  let base;
  if (initialize) {
    try {
      await readFile(path);
      throw new Error('compiler baseline already exists; regular refresh can only shrink it');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    // Initialization belongs to the published source basis. Never include
    // another lane's held app/package diagnostics in that initial allowance.
    const dirty = await gitOutput(rootDir, ['status', '--porcelain', '--untracked-files=normal', '--', 'apps', 'packages']);
    if (dirty.trim()) throw new Error('compiler baseline initialization requires clean published apps and packages');
  } else {
    if (!options.baselineBaseRef) throw new Error('compiler baseline check/refresh requires --baseline-base-ref');
    baseline = parseCompilerBaseline(await readFile(path, 'utf8'));
    base = parseCompilerBaseline(await gitOutput(rootDir, ['show', `${options.baselineBaseRef}:${baselinePath}`]));
    assertCompilerBaselineDoesNotIncrease(baseline, base);
  }
  const diagnostics: ReturnType<typeof diagnosticsFromCompilerReport> = [];
  const packages = new Set<string>();
  const runCommand = options.runCommand ?? ((command, env) => runPnpmCommand(command, rootDir, env));
  const checked = await runCommandSuite({ commands, maxConcurrent: 1, suiteName: 'Root compiler baseline suite', runCommand: async command => {
    const reportDir = await mkdtemp(resolve(tmpdir(), 'happier-compiler-diagnostics-'));
    let failure: unknown;
    try {
      try { await runCommand(command, { ...process.env, HAPPIER_TYPECHECK_REPORT_DIR: reportDir }); } catch (error) { failure = error; }
      const reports = await readdir(reportDir);
      if (!reports.length) throw new Error(`${command.id}: no complete native compiler reports`);
      let rejectedSource = false;
      for (const name of reports) {
        const report = JSON.parse(await readFile(resolve(reportDir, name), 'utf8'));
        diagnostics.push(...diagnosticsFromCompilerReport(report, rootDir));
        packages.add(compilerReportPackage(report, rootDir));
        rejectedSource ||= report.status !== 0;
      }
      if (failure && !(failure instanceof Error && 'exitCode' in failure && [1, 2].includes(Number(failure.exitCode))
        && 'signal' in failure && failure.signal === null && rejectedSource)) throw failure;
      if (!failure && rejectedSource) throw new Error(`${command.id}: native compiler failure was hidden by its caller`);
    } finally { await rm(reportDir, { recursive: true, force: true }); }
  } });
  if (initialize) {
    const sourceCommit = (await gitOutput(rootDir, ['rev-parse', 'HEAD'])).trim();
    await writeJsonAtomic(path, { sourceCommit, diagnostics });
    process.stdout.write(`Initialized compiler baseline with ${diagnostics.length} diagnostic occurrences at ${sourceCommit}\n`);
    return checked;
  }
  const patches = new Map<string, string>();
  for (const file of new Set(baseline.diagnostics.map(row => row.file))) {
    patches.set(file, await gitOutput(rootDir, ['diff', '--no-ext-diff', '--no-textconv', '--unified=0', baseline.sourceCommit, '--', file]));
  }
  const selected = value => ({ ...value, diagnostics: value.diagnostics.filter(row => packages.has(row.package)) });
  const refreshed = compareCompilerBaseline(selected(baseline), selected(base), diagnostics, (line, file) => mapUnchangedLine(line, patches.get(file) ?? ''));
  const next = { ...baseline, diagnostics: [...baseline.diagnostics.filter(row => !packages.has(row.package)), ...refreshed.diagnostics] };
  if (options.baselineMode === 'refresh') {
    await writeJsonAtomic(path, next);
    process.stdout.write(`Compiler baseline refreshed: ${baseline.diagnostics.length} → ${next.diagnostics.length} diagnostic occurrences\n`);
  } else if (next.diagnostics.length !== baseline.diagnostics.length) {
    throw new Error('resolved compiler diagnostics must be removed with --compiler-baseline=refresh');
  }
  return checked;
}

const ROOT_TYPE_TEST_COMMAND = {
  id: 'type-tests',
  args: [
    'run', 'tsc', '--noEmit',
    '-p', 'packages/protocol/tsconfig.json',
    '-p', 'packages/plugins/triage/tsconfig.json',
  ],
} as const satisfies CommandSuiteEntry;

const ROOT_TYPECHECK_PREPARATION_COMMANDS = [
  { id: 'prepare-workspaces', args: ['run', '--silent', 'prepare:typecheck:workspaces'] },
] as const satisfies readonly CommandSuiteEntry[];

export const ROOT_TYPECHECK_COMMANDS = [
  ...ROOT_TYPECHECK_PREPARATION_COMMANDS,
  {
    id: 'public-sdk',
    args: [
      'exec', 'turbo',
      'run',
      'typecheck:finite',
      '--continue=always',
      '--filter=@happier-dev/plugin-sdk',
      '--filter=@happier-dev/sdk',
    ],
  },
  {
    id: 'source-workspaces',
    args: [
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
  },
  ROOT_TYPE_TEST_COMMAND,
] as const satisfies readonly CommandSuiteEntry[];

const ROOT_COMPILER_TYPECHECK_COMMANDS: readonly CommandSuiteEntry[] = [
  ROOT_TYPE_TEST_COMMAND,
  ...[
    'packages/plugin-sdk/tsconfig.json',
    'packages/plugin-sdk/tsconfig.tests.json',
    'packages/sdk/tsconfig.tests.json',
    'packages/terminal-native/tsconfig.json',
    'packages/plugin-ui/tsconfig.json',
    'apps/ui/tsconfig.json',
    'apps/cli/tsconfig.json',
    'apps/server/tsconfig.json',
    'packages/tests/tsconfig.json',
  ].map((project) => ({
    id: project,
    // Host packages own their declaration-producing project order and dispatch.
    args: project === 'apps/ui/tsconfig.json'
      ? ['--dir', 'apps/ui', 'run', '--silent', 'typecheck']
      : project === 'apps/cli/tsconfig.json'
        ? ['--dir', 'apps/cli', 'run', '--silent', 'typecheck']
      : project === 'apps/server/tsconfig.json'
        ? ['--dir', 'apps/server', 'run', '--silent', 'typecheck']
      : project === 'packages/tests/tsconfig.json'
        ? ['--dir', 'packages/tests', 'run', '--silent', 'typecheck']
      : ['run', 'tsc', '-p', project, '--noEmit'],
  })),
];

export interface RunRootTypecheckOptions {
  rootDir?: string;
  commands?: readonly CommandSuiteEntry[];
  compilerOnly?: boolean;
  compilerPartition?: 'ui' | 'host';
  // The caller must have restored this run's successful canonical preparation,
  // including generated sources and physical workspace dependency outputs.
  preparedWorkspaces?: boolean;
  baselineMode?: 'check' | 'initialize' | 'refresh';
  baselinePath?: string;
  baselineBaseRef?: string;
  runCommand?: (command: CommandSuiteEntry, env?: NodeJS.ProcessEnv) => Promise<void>;
}

export async function runRootTypecheck(
  options: RunRootTypecheckOptions = {},
): Promise<readonly CommandSuiteEntry[]> {
  if (options.preparedWorkspaces && !options.compilerOnly) {
    throw new Error('prepared workspaces require compiler-only mode');
  }
  if (options.compilerPartition && !options.compilerOnly) {
    throw new Error('compiler partition requires compiler-only mode');
  }
  if (options.baselineMode && !options.compilerOnly) throw new Error('compiler baseline requires compiler-only mode');
  const rootDir = options.rootDir ?? process.cwd();
  const selectedCommands = options.commands ?? (options.compilerOnly ? ROOT_COMPILER_TYPECHECK_COMMANDS : ROOT_TYPECHECK_COMMANDS);
  const commands = options.compilerPartition
    ? selectedCommands.filter(({ id }) => (id === 'apps/ui/tsconfig.json') === (options.compilerPartition === 'ui'))
    : selectedCommands;
  const runCommand = options.runCommand ?? ((command) => runPnpmCommand(command, rootDir));
  const prepared = options.compilerOnly && !options.commands && !options.preparedWorkspaces
    ? await runCommandSuite({
      commands: ROOT_TYPECHECK_PREPARATION_COMMANDS,
      maxConcurrent: 1,
      suiteName: 'Root typecheck preparation',
      runCommand,
    })
    : [];
  // Consumer diagnostics are meaningful only after current declarations have
  // published successfully; retain complete failure collection within each phase.
  const checked = options.baselineMode ? await runBaselineCompilerSuite(rootDir, commands, options) : await runCommandSuite({
    commands,
    maxConcurrent: 1,
    suiteName: 'Root typecheck suite',
    runCommand,
  });
  return [...prepared, ...checked];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void (async () => {
    const compilerPartition = process.argv.find((arg) => arg.startsWith('--compiler-partition='))?.slice('--compiler-partition='.length);
    if (process.argv.includes('--compiler-partition') || (compilerPartition !== undefined && compilerPartition !== 'ui' && compilerPartition !== 'host')) {
      throw new Error('compiler partition must be ui or host');
    }
    const baselineMode = process.argv.find(arg => arg.startsWith('--compiler-baseline='))?.slice('--compiler-baseline='.length);
    if (process.argv.includes('--compiler-baseline') || (baselineMode !== undefined && baselineMode !== 'check' && baselineMode !== 'initialize' && baselineMode !== 'refresh')) {
      throw new Error('compiler baseline must be check, initialize or refresh');
    }
    return await runRootTypecheck({
      compilerOnly: process.argv.includes('--compiler-only'),
      preparedWorkspaces: process.argv.includes('--prepared-workspaces'),
      compilerPartition,
      baselineMode,
      baselinePath: process.argv.find(arg => arg.startsWith('--baseline-path='))?.slice('--baseline-path='.length),
      baselineBaseRef: process.argv.find(arg => arg.startsWith('--baseline-base-ref='))?.slice('--baseline-base-ref='.length),
    });
  })().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
