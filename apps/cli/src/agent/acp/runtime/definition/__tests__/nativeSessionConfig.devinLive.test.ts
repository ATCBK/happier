import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEVIN_ACP_RUNTIME_DECLARATION } from '../../../../../../../../packages/plugins/devin/src/agent/acp/runtimeDeclaration';
import { prepareNativeSessionConfig } from '../nativeSessionConfig';

/**
 * Live gate for the one fact the fixture ACP agent cannot prove: that the real
 * Devin CLI reads the Session MCP config from the root this declaration points
 * it at. Devin's ACP `initialize` reports its resolved `mcpConfigPath`, so an
 * unauthenticated probe is enough — no vendor credentials are required.
 *
 * Opt in with the same provider flag the e2e provider lanes use:
 *   HAPPIER_E2E_PROVIDER_DEVIN=1 vitest run …/nativeSessionConfig.devinLive
 */
const LIVE = process.env.HAPPIER_E2E_PROVIDER_DEVIN === '1';
const DEVIN_BIN = process.env.HAPPIER_E2E_PROVIDER_DEVIN_BIN ?? 'devin';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function createDirectory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

async function readDevinInitialize(env: Readonly<Record<string, string>>): Promise<Readonly<{
  mcpConfigPath?: string;
  mcpCapabilities?: Readonly<Record<string, unknown>>;
  loadSession?: boolean;
}>> {
  const child = spawn(DEVIN_BIN, ['acp'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...env },
  });
  let stdout = '';
  const settled = new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes('\n')) resolve();
    });
    child.on('error', () => resolve());
    setTimeout(resolve, 20_000);
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: {} },
  })}\n`);
  try {
    await settled;
  } finally {
    child.kill('SIGKILL');
  }
  const line = stdout.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  const result = (JSON.parse(line) as { result?: Record<string, unknown> }).result ?? {};
  const capabilities = result.agentCapabilities as Record<string, unknown> | undefined;
  const meta = result._meta as Record<string, unknown> | undefined;
  return {
    ...(typeof meta?.mcpConfigPath === 'string' ? { mcpConfigPath: meta.mcpConfigPath } : {}),
    ...(capabilities?.mcpCapabilities
      ? { mcpCapabilities: capabilities.mcpCapabilities as Record<string, unknown> }
      : {}),
    ...(typeof capabilities?.loadSession === 'boolean'
      ? { loadSession: capabilities.loadSession }
      : {}),
  };
}

describe.skipIf(!LIVE)('Devin native Session MCP config (live CLI)', () => {
  it('reads the Session MCP config from the root the declaration materializes', async () => {
    const home = createDirectory('happier-devin-live-home-');
    const userConfigRoot = join(home, '.config');
    await mkdir(join(userConfigRoot, 'devin'), { recursive: true });
    await writeFile(
      join(userConfigRoot, 'devin', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { userTool: { command: 'user-tool' } } }),
    );

    const baseline = await readDevinInitialize({ HOME: home, XDG_CONFIG_HOME: userConfigRoot });
    // The advertised MCP capabilities are why this Agent declares `drop`: its
    // ACP server offers no stdio Session MCP input for Happier to pass through.
    expect(baseline.mcpCapabilities).toMatchObject({ http: false, sse: false });
    expect(baseline.mcpConfigPath).toBe(join(userConfigRoot, 'devin', 'mcp_config.json'));
    expect(baseline.loadSession).toBe(true);

    const delivery = await prepareNativeSessionConfig({
      declaration: DEVIN_ACP_RUNTIME_DECLARATION.definition.mcp.nativeSessionConfig,
      cwd: home,
      env: { HOME: home, XDG_CONFIG_HOME: userConfigRoot },
      mcpServers: { happier: { command: '/opt/happier-mcp', args: ['bridge'] } },
      platform: 'linux',
    });
    try {
      const sessionRoot = delivery.env.XDG_CONFIG_HOME!;
      const live = await readDevinInitialize({ HOME: home, ...delivery.env });
      expect(live.mcpConfigPath).toBe(join(sessionRoot, 'devin', 'mcp_config.json'));
      expect(
        Object.keys(JSON.parse(readFileSync(live.mcpConfigPath!, 'utf8')).mcpServers).sort(),
      ).toEqual(['happier', 'userTool']);
    } finally {
      delivery.cleanup();
    }
  }, 60_000);
});
