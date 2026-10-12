import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { bundleCliSourceSidecars, readWorkspacePackages } from '@happier-dev/cli-common/sourceRuntimeEntries';
import { createHappierTempDir, getHappierTempDirOwnerPath, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';

function createRunnerScriptHarness() {
  const scriptPath = resolve(__dirname, '../../../scripts/terminal_launch_spec_runner.cjs');
  const source = readFileSync(scriptPath, 'utf8').replace(/^#!.*\n/, '');
  const child = new EventEmitter();
  const spawn = vi.fn((
    _command: string,
    _args: readonly string[],
    _options: Readonly<Record<string, unknown>>,
  ) => child);
  const fakeProcess = Object.assign(new EventEmitter(), {
    argv: ['node', scriptPath],
    env: {},
    exit: vi.fn(),
    cwd: vi.fn(() => '/tmp/workspace'),
    stdout: { write: vi.fn() },
    stderr: { write: vi.fn() },
  });
  const module = { exports: {} as Record<string, unknown> };
  const fakeRequire = Object.assign((id: string) => {
    if (id === 'node:child_process') return { spawn };
    if (id === 'node:fs/promises' || id === 'node:fs') return require(id);
    if (id === 'node:path') return require(id);
    if (id === './process_tree.cjs') return createRequire(scriptPath)(id);
    throw new Error(`unexpected require: ${id}`);
  }, { main: {} });

  vm.runInNewContext(source, {
    console,
    module,
    exports: module.exports,
    process: fakeProcess,
    require: fakeRequire,
  });

  return { child, fakeProcess, module, spawn };
}

describe('terminal_launch_spec_runner.cjs', () => {
  it('stages a standalone runner that removes its consumed marked handoff without package resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-staged-terminal-runner-test-'));
    const directory = createHappierTempDir({ purpose: 'terminal-launch', root });
    const marker = getHappierTempDirOwnerPath(directory);
    try {
      const repoDir = resolve(__dirname, '../../../../..');
      const outputDir = join(root, 'scripts');
      await bundleCliSourceSidecars({ repoDir, outputDir, build,
        workspacePackages: await readWorkspacePackages(repoDir),
        requireFromProject: createRequire(join(repoDir, 'apps/cli/package.json')) });
      const specPath = join(directory, 'launch.json');
      await writeFile(specPath, JSON.stringify({ command: process.execPath,
        args: ['-e', 'process.exit(0)'], cwd: root, env: {} }));
      await promisify(execFile)(process.execPath, [join(outputDir, 'terminal_launch_spec_runner.cjs'), specPath]);
      await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeHappierTempDirAsync(directory);
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not turn a genuine native spawn receipt into a startup failure on a later process error', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
    const receipt = join(directory, 'native-startup.json');
    const { child, module } = createRunnerScriptHarness();
    const run = module.exports.runLaunchSpec as (spec: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; spawnResultPath: string }) => Promise<number>;
    try {
      const result = run({ command: 'child', args: [], cwd: directory, env: {}, spawnResultPath: receipt });
      const failed = expect(result).rejects.toThrow('native operation failed after startup');
      child.emit('spawn');
      child.emit('error', new Error('native operation failed after startup'));
      await failed;
      expect(JSON.parse(await readFile(receipt, 'utf8'))).toEqual({ status: 'spawned' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects a receipt outside its exact private sibling without overwriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
    const specPath = join(directory, 'launch.json');
    const unrelated = join(directory, 'unrelated-private-file');
    await writeFile(unrelated, 'preserved');
    await writeFile(specPath, JSON.stringify({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: directory, env: {}, spawnResultPath: unrelated }));
    try {
      await expect(promisify(execFile)(process.execPath, [resolve(__dirname, '../../../scripts/terminal_launch_spec_runner.cjs'), specPath])).rejects.toMatchObject({ code: 127 });
      await expect(readFile(unrelated, 'utf8')).resolves.toBe('preserved');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('keeps a completed native outcome but reports an unwritable startup receipt without private data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
    const specPath = join(directory, 'launch.json');
    const receipt = join(directory, 'native-startup.json');
    await mkdir(receipt);
    await writeFile(specPath, JSON.stringify({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: directory, env: {}, spawnResultPath: receipt }));
    try {
      const result = await promisify(execFile)(process.execPath, [resolve(__dirname, '../../../scripts/terminal_launch_spec_runner.cjs'), specPath]);
      expect(result.stderr).toContain('terminal_native_startup_unknown');
      expect(result.stderr).not.toContain(directory);
      expect(result.stderr).not.toContain('terminal_launch_artifact_cleanup_incomplete');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('reports unexpected launch-directory cleanup failure without replacing the native outcome', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
    const specPath = join(directory, 'launch.json');
    const unexpected = join(directory, 'unexpected');
    await writeFile(unexpected, 'retained');
    await writeFile(specPath, JSON.stringify({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: directory, env: {} }));
    try {
      const result = await promisify(execFile)(process.execPath, [resolve(__dirname, '../../../scripts/terminal_launch_spec_runner.cjs'), specPath]);
      expect(result.stderr).toContain('terminal_launch_artifact_cleanup_incomplete');
      await expect(readFile(unexpected, 'utf8')).resolves.toBe('retained');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('reports a native signal rejected without an exception over the lifetime channel', async () => {
    const { child, module } = createRunnerScriptHarness();
    Object.assign(child, { kill: vi.fn(() => false) });
    const channel = Object.assign(new EventEmitter(), { connected: true, send: vi.fn() });
    const run = module.exports.runLaunchSpec as (spec: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }, signal: undefined, controller: typeof channel) => Promise<number>;
    const result = run({ command: 'child', args: [], cwd: '/tmp/workspace', env: {} }, undefined, channel);
    channel.emit('message', { type: 'terminal-native-signal', signal: 'SIGINT' });
    expect(channel.send).toHaveBeenCalledWith({ type: 'terminal-native-signal-failed' }, expect.any(Function));
    child.emit('close', 0, null);
    await expect(result).resolves.toBe(0);
  });
  it('preserves validated Windows shim argument custody through the private launch file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-terminal-launch-'));
    const specPath = join(directory, 'launch.json');
    const spec = { command: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', '"C:\\agent.cmd" "opaque arg"'], cwd: 'C:\\workspace', env: {}, windowsVerbatimArguments: true };
    await writeFile(specPath, JSON.stringify(spec));
    try {
      const { module, child, spawn } = createRunnerScriptHarness();
      const readSpec = module.exports.readLaunchSpecFile as (path: string) => Promise<typeof spec>;
      const run = module.exports.runLaunchSpec as (input: typeof spec) => Promise<number>;
      const loaded = await readSpec(specPath);
      const result = run(loaded);
      expect(spawn).toHaveBeenCalledWith(spec.command, spec.args, expect.objectContaining({ windowsVerbatimArguments: true }));
      child.emit('close', 0, null);
      await expect(result).resolves.toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('ignores terminal interrupt signals while the child is alive', async () => {
    const { child, fakeProcess, module, spawn } = createRunnerScriptHarness();
    const runLaunchSpec = module.exports.runLaunchSpec as (spec: {
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    }) => Promise<number>;

    const result = runLaunchSpec({ command: 'child', args: [], cwd: '/tmp/workspace', env: {} });

    expect(fakeProcess.listenerCount('SIGINT')).toBe(1);
    expect(fakeProcess.listenerCount('SIGQUIT')).toBe(1);
    expect(fakeProcess.listenerCount('SIGTSTP')).toBe(0);
    fakeProcess.emit('SIGINT');
    child.emit('close', 0, null);

    await expect(result).resolves.toBe(0);
    expect(spawn.mock.calls[0]?.[2]).not.toHaveProperty('windowsVerbatimArguments');
    expect(fakeProcess.listenerCount('SIGINT')).toBe(0);
    expect(fakeProcess.listenerCount('SIGQUIT')).toBe(0);
    expect(fakeProcess.listenerCount('SIGTSTP')).toBe(0);
  });

  it('preserves Windows verbatim-argument semantics for a resolved shell shim', async () => {
    const { child, module, spawn } = createRunnerScriptHarness();
    const runLaunchSpec = module.exports.runLaunchSpec as (spec: {
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      windowsVerbatimArguments?: boolean;
    }) => Promise<number>;

    const result = runLaunchSpec({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Users\\alice\\claude.cmd" --continue'],
      cwd: 'C:\\workspace',
      env: {},
      windowsVerbatimArguments: true,
    });

    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', '"C:\\Users\\alice\\claude.cmd" --continue'],
      expect.objectContaining({ windowsVerbatimArguments: true }),
    );
    child.emit('close', 0, null);
    await expect(result).resolves.toBe(0);
  });
});
