import type { PluginAgentAcpNativeSessionMcpConfigV2 } from '@happier-dev/protocol';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareNativeSessionConfig } from '../nativeSessionConfig';

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
    const delivery = await prepareNativeSessionConfig({
      declaration: DECLARATION,
      cwd: createHome(),
      env: { HOME: createHome() },
      mcpServers: {},
      platform: 'linux',
    });
    expect(delivery.env).toEqual({});
  });

  it('composes a real skills directory and preserves native MCP subprocess config provenance for a skills-only launch', async () => {
    const home = createHome();
    const sourceRoot = join(home, '.config');
    await mkdir(join(sourceRoot, 'devin', 'skills', 'native'), { recursive: true });
    await writeFile(join(sourceRoot, 'devin', 'skills', 'native', 'SKILL.md'), 'native skill');
    const originalMcp = '{"mcpServers":{"user":{"command":"user-tool"}}}';
    await writeFile(join(sourceRoot, 'devin', 'mcp_config.json'), originalMcp);
    const skillsRoot = join(home, 'session', 'skills');
    await mkdir(join(skillsRoot, 'delivered', 'scripts'), { recursive: true });
    await writeFile(join(skillsRoot, 'delivered', 'SKILL.md'), 'delivered skill');
    await writeFile(join(skillsRoot, 'delivered', 'scripts', 'nested.txt'), 'supporting file');
    const delivery = await prepareNativeSessionConfig({
      declaration: DECLARATION, cwd: home, env: { HOME: home }, mcpServers: {}, platform: 'linux',
      skills: { subdirectory: 'skills', delivery: { pluginRoot: join(home, 'session'), skillsRoot,
        items: [{ name: 'delivered', skillId: 'delivered', digest: 'sha256:fixture', directory: join(skillsRoot, 'delivered') }], nativeDisables: [] } },
    });
    cleanups.push(delivery.cleanup);
    const privateRoot = delivery.env.XDG_CONFIG_HOME!;
    expect(privateRoot).toBeTruthy();
    const privateSkills = join(privateRoot, 'devin', 'skills');
    expect(lstatSync(privateSkills).isDirectory()).toBe(true);
    expect(lstatSync(privateSkills).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(privateSkills, 'native', 'SKILL.md'), 'utf8')).toBe('native skill');
    expect(readFileSync(join(privateSkills, 'delivered', 'scripts', 'nested.txt'), 'utf8')).toBe('supporting file');
    expect(JSON.parse(readFileSync(join(privateRoot, 'devin', 'mcp_config.json'), 'utf8'))).toEqual({
      mcpServers: { user: { command: 'user-tool', env: { XDG_CONFIG_HOME: sourceRoot } } },
    });
    expect(readFileSync(join(sourceRoot, 'devin', 'mcp_config.json'), 'utf8')).toBe(originalMcp);
    expect(existsSync(join(sourceRoot, 'devin', 'skills', 'delivered'))).toBe(false);
    delivery.cleanup();
    expect(existsSync(privateRoot)).toBe(false);
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

    const delivery = await prepareNativeSessionConfig({
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

    const delivery = await prepareNativeSessionConfig({
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

    await expect(prepareNativeSessionConfig({
      declaration: DECLARATION,
      cwd: workspace,
      env: { HOME: home },
      mcpServers: { happier: { command: '/opt/happier-mcp' } },
      platform: 'linux',
    })).rejects.toThrow(/shadows the Session MCP server 'happier'/);
  });
});
