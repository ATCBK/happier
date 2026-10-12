import type { PluginAgentAcpNativeSessionMcpConfigV2 } from '@happier-dev/protocol';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
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
};
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

describe('native session MCP config root', () => {
  it.each(['linux', 'win32'] as const)('preserves every config-root child beside the privately composed provider directory on %s', async (platform) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'happier-config-root-')));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const sourceRoot = join(home, 'user-config');
    for (const entry of ['git', 'gh', 'cognition', 'devin']) await mkdir(join(sourceRoot, entry), { recursive: true });
    await writeFile(join(sourceRoot, 'git', 'config'), '[user]\nname = Config Root User\n');
    await writeFile(join(sourceRoot, 'gh', 'hosts.yml'), 'example.invalid:\n  user: config-user\n');
    await writeFile(join(sourceRoot, 'cognition', 'settings.json'), '{"model":"saved"}');
    await writeFile(join(sourceRoot, 'other.config'), 'ordinary root file');
    const nativeConfig = { version: 2, mcpServers: { user: { command: '/user/server' } } };
    await writeFile(join(sourceRoot, 'devin', 'mcp_config.json'), JSON.stringify(nativeConfig));
    await writeFile(join(sourceRoot, 'devin', 'settings.json'), '{"saved":true}');
    const envKey = platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';

    const delivery = await prepareNativeSessionMcpConfig({
      declaration: DECLARATION, cwd: home, env: { HOME: home, [envKey]: sourceRoot }, platform,
      mcpServers: { happier: { command: '/happier/server' } },
    });
    cleanups.push(delivery.cleanup);
    const privateRoot = delivery.env[envKey]!;
    expect(readdirSync(privateRoot).sort()).toEqual(readdirSync(sourceRoot).sort());
    for (const path of [['git', 'config'], ['gh', 'hosts.yml'], ['cognition', 'settings.json'], ['other.config']]) {
      expect(readFileSync(join(privateRoot, ...path), 'utf8')).toBe(readFileSync(join(sourceRoot, ...path), 'utf8'));
      expect(realpathSync(join(privateRoot, path[0]!))).toBe(join(sourceRoot, path[0]!));
    }
    expect(lstatSync(join(privateRoot, 'devin')).isDirectory()).toBe(true);
    expect(lstatSync(join(privateRoot, 'devin')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(privateRoot, 'devin', 'mcp_config.json')).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(join(privateRoot, 'devin', 'mcp_config.json'), 'utf8')).mcpServers).toEqual({
      user: { command: '/user/server', env: { [envKey]: sourceRoot } },
      happier: { command: '/happier/server', args: [], env: { [envKey]: sourceRoot }, transport: 'stdio' },
    });
    expect(JSON.parse(readFileSync(join(sourceRoot, 'devin', 'mcp_config.json'), 'utf8'))).toEqual(nativeConfig);
    delivery.cleanup();
    expect(existsSync(privateRoot)).toBe(false);
    expect(readFileSync(join(sourceRoot, 'git', 'config'), 'utf8')).toContain('Config Root User');
  });
});
