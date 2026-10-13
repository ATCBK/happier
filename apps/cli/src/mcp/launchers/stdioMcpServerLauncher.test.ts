import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

import { projectPath } from '@/projectPath';
import { removeWrittenMcpRuntimeConfigFile, writeSecureMcpRuntimeConfigFile } from '@/mcp/runtime/writeSecureMcpRuntimeConfigFile';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';

function resolveEnvRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function resolveLauncherInvocation(options: Readonly<{ forceSource?: boolean }> = {}): { command: string; args: string[]; env?: Record<string, string> } {
  const distEntrypoint = join(projectPath(), 'dist', 'mcp', 'launchers', 'stdioMcpServerLauncher.mjs');
  if (!options.forceSource && existsSync(distEntrypoint)) {
    return {
      command: process.execPath,
      args: [distEntrypoint],
    };
  }

  const sourceEntrypoint = join(projectPath(), 'src', 'mcp', 'launchers', 'stdioMcpServerLauncher.ts');
  const tsxHook = resolveTsxImportHookPath();
  if (!tsxHook) {
    throw new Error('Expected tsx import hook to be resolvable when the built launcher entrypoint is unavailable');
  }

  return {
    command: process.execPath,
    args: ['--no-warnings', '--no-deprecation', '--import', pathToFileURL(tsxHook).href, sourceEntrypoint],
    env: {
      TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
    },
  };
}

describe('stdioMcpServerLauncher', () => {
  it('reports a spawn failure when initialize framing finishes after the child error', async () => {
    const configPath = await writeSecureMcpRuntimeConfigFile({ prefix: 'happier-mcp-delayed-initialize', tmpDir: null,
      payload: { command: 'happier-fixture-missing-command', args: [] } });
    try {
      const invocation = resolveLauncherInvocation({ forceSource: true });
      const child = spawn(invocation.command, invocation.args, { env: { ...resolveEnvRecord(), ...invocation.env,
        HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath }, stdio: ['pipe', 'pipe', 'pipe'] });
      const request = serializeMessage({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} });
      const split = request.length - 2;
      let output = '';
      let stderr = '';
      let finished = false;
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => {
        stderr += String(chunk);
        if (!finished && stderr.includes('ENOENT')) {
          finished = true;
          child.stdin.end(request.slice(split));
        }
      });
      child.stdin.write(request.slice(0, split));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      expect(code).toBe(1);
      expect(deserializeMessage(output.trim())).toMatchObject({ id: 7, error: { code: -32603,
        data: { t: 'happier-mcp-stdio-spawn-failure-v1', code: 'ENOENT', path: 'happier-fixture-missing-command' } } });
      expect(stderr).not.toContain('EPIPE');
    } finally { removeWrittenMcpRuntimeConfigFile(configPath, true); }
  });

  it.each(['ignore', 'end', 'cancel'] as const)('exits a missing child when stdin is %s without removing its config', async stdinMode => {
    const configPath = await writeSecureMcpRuntimeConfigFile({ prefix: 'happier-mcp-missing-child', tmpDir: null,
      payload: { command: 'happier-fixture-missing-command', args: [] } });
    try {
      const invocation = resolveLauncherInvocation({ forceSource: true });
      const child = spawn(invocation.command, invocation.args, { env: { ...resolveEnvRecord(), ...invocation.env,
        HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath }, stdio: [stdinMode === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', chunk => {
        stderr += String(chunk);
        if (stdinMode === 'end') child.stdin?.end();
        if (stdinMode === 'cancel') child.kill('SIGTERM');
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      expect(code).not.toBe(0);
      expect(stderr).toContain('ENOENT');
      expect(existsSync(configPath)).toBe(true);
    } finally { removeWrittenMcpRuntimeConfigFile(configPath, true); }
  });

  it('keeps host ownership when MCP config supplies a forged owner', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-owner-'));
    try {
      const configPath = join(tmp, 'config.json');
      const hostTag = 'v1.0123456789ab.run.run-mcp';
      await writeFile(configPath, JSON.stringify({ command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.HAPPIER_PROCESS_OWNER || "absent")'],
        env: { HAPPIER_PROCESS_OWNER: 'forged-mcp' } }), { mode: 0o600 });
      const invocation = resolveLauncherInvocation({ forceSource: true });
      const child = spawn(invocation.command, invocation.args, { env: { ...resolveEnvRecord(), ...invocation.env,
        HAPPIER_PROCESS_OWNER: hostTag, HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let stderr = '';
      child.stdout.on('data', chunk => { output += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', resolve);
      });
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      expect(output).toBe(hostTag);
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });
  it('preserves the writer-owned config for relaunch until its owner cleans up', async () => {
    const prefix = 'happier-mcp-stdio-launcher';
    const configPath = await writeSecureMcpRuntimeConfigFile({
      prefix,
      tmpDir: null,
      payload: { env: { API_KEY: 'SHOULD_NOT_PERSIST' } },
    });
    const ownedDirectory = dirname(configPath);

    try {
      const launcherInvocation = resolveLauncherInvocation({ forceSource: true });
      const child = spawn(launcherInvocation.command, launcherInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(launcherInvocation.env ?? {}),
          HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });

      expect(exitCode).not.toBe(0);
      expect(stderr).not.toContain('ENOENT');
      expect(existsSync(configPath)).toBe(true);
      removeWrittenMcpRuntimeConfigFile(configPath, true);
      expect(existsSync(ownedDirectory)).toBe(false);
    } finally {
      await rm(ownedDirectory, { recursive: true, force: true });
    }
  });

  it('preserves the config file when startup fails before config parsing succeeds', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-stdio-launcher-test-'));
    try {
      const configPath = join(tmp, 'happier-mcp-stdio-launcher.test.json');
      await writeFile(configPath, '{"env":{"API_KEY":"SHOULD_NOT_PERSIST"}', { mode: 0o600 });

      const launcherInvocation = resolveLauncherInvocation({ forceSource: true });
      const child = spawn(launcherInvocation.command, launcherInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(launcherInvocation.env ?? {}),
          HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });

      expect(exitCode).not.toBe(0);
      expect(existsSync(configPath)).toBe(true);
      expect(existsSync(tmp)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('does not remove non-tmp config files even when startup fails', async () => {
    const outsideRoot = join(projectPath(), '.project', 'tmp', 'mcp-stdio-launcher-tests');
    await mkdir(outsideRoot, { recursive: true });

    const tmp = await mkdtemp(join(outsideRoot, 'case-'));
    try {
      const configPath = join(tmp, 'happier-mcp-stdio-launcher.outside-tmp.json');
      await writeFile(configPath, '{"env":{"API_KEY":"SHOULD_NOT_PERSIST"}', { mode: 0o600 });

      const launcherInvocation = resolveLauncherInvocation({ forceSource: true });
      const child = spawn(launcherInvocation.command, launcherInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(launcherInvocation.env ?? {}),
          HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE: configPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });

      expect(exitCode).not.toBe(0);
      expect(existsSync(configPath)).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
