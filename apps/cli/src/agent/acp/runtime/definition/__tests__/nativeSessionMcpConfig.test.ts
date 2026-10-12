import type { PluginAgentAcpNativeSessionMcpConfigV2 } from '@happier-dev/protocol';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareNativeSessionMcpConfig } from '../nativeSessionMcpConfig';

const DECLARATION: PluginAgentAcpNativeSessionMcpConfigV2 = {
  configRootEnvKey: { posix: 'XDG_CONFIG_HOME', win32: 'APPDATA' },
  homeRelativeConfigRoot: { posix: ['.config'], win32: ['AppData', 'Roaming'] },
  directory: 'devin',
  fileName: 'mcp_config.json',
  serversKey: 'mcpServers',
  serverEntryConstants: { transport: 'stdio' },
  projectShadowPaths: ['.devin/mcp_config.json'],
};

const cleanups: Array<() => void> = [];

function createHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'happier-native-mcp-')));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

describe('native session MCP config delivery', () => {
  it('does nothing when the Session contributes no MCP servers', async () => {
    const delivery = await prepareNativeSessionMcpConfig({
      declaration: DECLARATION,
      cwd: createHome(),
      env: { HOME: createHome() },
      mcpServers: {},
      platform: 'linux',
    });
    expect(delivery.env).toEqual({});
  });

  it('merges Session servers into a session-private root that links the real provider state', async () => {
    const home = createHome();
    const configRoot = join(home, '.config');
    const devinDir = join(configRoot, 'devin');
    await mkdir(join(configRoot, 'cognition'), { recursive: true });
    await mkdir(devinDir, { recursive: true });
    await writeFile(join(devinDir, 'config.json'), '{"user":true}');
    await writeFile(
      join(devinDir, 'mcp_config.json'),
      JSON.stringify({ version: 2, mcpServers: { userTool: { command: 'user-tool' } } }),
    );

    const delivery = await prepareNativeSessionMcpConfig({
      declaration: DECLARATION,
      cwd: home,
      env: { HOME: home },
      mcpServers: {
        happier: { command: '/opt/happier-mcp', args: ['bridge'], env: { SESSION_TOKEN: 'token' } },
      },
      platform: 'linux',
    });

    const sessionRoot = delivery.env.XDG_CONFIG_HOME!;
    expect(sessionRoot).toBeTruthy();
    expect(sessionRoot).not.toBe(configRoot);
    expect(JSON.parse(readFileSync(join(sessionRoot, 'devin', 'mcp_config.json'), 'utf8'))).toEqual({
      version: 2,
      mcpServers: {
        userTool: { command: 'user-tool', env: { XDG_CONFIG_HOME: configRoot } },
        happier: {
          command: '/opt/happier-mcp',
          args: ['bridge'],
          env: { XDG_CONFIG_HOME: configRoot, SESSION_TOKEN: 'token' },
          transport: 'stdio',
        },
      },
    });
    // Real provider state stays linked, and the user's own file is unchanged.
    expect(lstatSync(join(sessionRoot, 'devin', 'config.json')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(sessionRoot, 'cognition')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(devinDir, 'mcp_config.json'), 'utf8')).mcpServers)
      .toEqual({ userTool: { command: 'user-tool' } });

    delivery.cleanup();
    delivery.cleanup();
    expect(existsSync(sessionRoot)).toBe(false);
  });

  it('reads the config root the Agent will actually use from the effective environment', async () => {
    const home = createHome();
    const declaredRoot = join(createHome(), 'provider-config');
    await mkdir(join(declaredRoot, 'devin'), { recursive: true });

    const delivery = await prepareNativeSessionMcpConfig({
      declaration: DECLARATION,
      cwd: home,
      env: { HOME: home, XDG_CONFIG_HOME: declaredRoot },
      mcpServers: { happier: { command: '/opt/happier-mcp' } },
      platform: 'linux',
    });
    const sessionRoot = delivery.env.XDG_CONFIG_HOME!;
    expect(
      JSON.parse(readFileSync(join(sessionRoot, 'devin', 'mcp_config.json'), 'utf8'))
        .mcpServers.happier.env.XDG_CONFIG_HOME,
    ).toBe(declaredRoot);
    delivery.cleanup();
  });

  it('fails the launch when a project config would shadow a Session server', async () => {
    const home = createHome();
    const workspace = join(home, 'workspace');
    await mkdir(join(workspace, '.git'), { recursive: true });
    await mkdir(join(workspace, '.devin'), { recursive: true });
    await writeFile(
      join(workspace, '.devin', 'mcp_config.json'),
      JSON.stringify({ mcpServers: { happier: { command: 'impostor' } } }),
    );

    await expect(prepareNativeSessionMcpConfig({
      declaration: DECLARATION,
      cwd: workspace,
      env: { HOME: home },
      mcpServers: { happier: { command: '/opt/happier-mcp' } },
      platform: 'linux',
    })).rejects.toThrow(/shadows the Session MCP server 'happier'/);
  });
});
