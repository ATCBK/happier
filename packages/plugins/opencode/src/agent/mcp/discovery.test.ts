import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOpenCodeMcpConfigServers } from './discovery.js';

describe('readOpenCodeMcpConfigServers', () => {
    it('reads real JSONC mcp local/remote config and project overrides without exposing values', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-opencode-native-'));
        try {
            const config = join(home, '.config', 'opencode');
            const project = join(home, 'project');
            await mkdir(config, { recursive: true });
            await mkdir(project);
            await writeFile(join(config, 'opencode.jsonc'), [
                '{ // Native OpenCode local server: command includes arguments.',
                '"mcp": { "local": { "type": "local", "command": ["bridge", "--stdio"], "environment": { "API_KEY": "private-native-value" }, "enabled": true },',
                '"remote": { "type": "remote", "url": "https://example.test/mcp", "headers": { "Authorization": "private-native-value" }, "enabled": false }, },',
                '}',
            ].join('\n'));
            await writeFile(join(project, 'opencode.json'), JSON.stringify({ mcp: { project: { type: 'local', command: ['project-bridge'] } } }));
            const result = await readOpenCodeMcpConfigServers({ env: { HOME: home, USERPROFILE: home }, directory: project });
            expect(result.warnings).toEqual([]);
            expect(result.servers).toMatchObject([
                { name: 'local', transport: 'stdio', stdio: { command: 'bridge', args: ['--stdio'] }, envKeys: ['API_KEY'], source: { kind: 'user', path: join(config, 'opencode.jsonc') } },
                { name: 'remote', transport: 'http', enabled: false, remote: { url: 'https://example.test/mcp', headers: ['Authorization'] } },
                { name: 'project', source: { kind: 'project', path: join(project, 'opencode.json') } },
            ]);
            expect(result.servers).toHaveLength(3);
            expect(JSON.stringify(result)).not.toContain('private-native-value');
        } finally { await rm(home, { recursive: true, force: true }); }
    });

    it('honors XDG and custom file overrides and reports invalid config', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-opencode-native-'));
        try {
            await mkdir(join(home, 'xdg', 'opencode'), { recursive: true });
            await writeFile(join(home, 'xdg', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { tool: { type: 'local', command: ['global'] } } }));
            await writeFile(join(home, 'custom.json'), JSON.stringify({ mcp: { tool: { type: 'local', command: ['custom', 'argument'] } } }));
            const env = { HOME: home, XDG_CONFIG_HOME: '~/xdg', OPENCODE_CONFIG: '~/custom.json' };
            expect((await readOpenCodeMcpConfigServers({ env })).servers).toMatchObject([{ name: 'tool', stdio: { command: 'custom', args: ['argument'] }, source: { path: join(home, 'custom.json') } }]);
            await writeFile(join(home, 'custom.json'), '{');
            expect((await readOpenCodeMcpConfigServers({ env })).warnings).toEqual([{ provider: 'opencode', code: 'parse_failed', path: join(home, 'custom.json') }]);
        } finally { await rm(home, { recursive: true, force: true }); }
    });
});
