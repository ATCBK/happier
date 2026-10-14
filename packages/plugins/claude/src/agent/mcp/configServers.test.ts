import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readClaudeMcpConfigServers } from './configServers.js';

describe('readClaudeMcpConfigServers', () => {
    it.each([false, true])('reads native user, local and project scopes (config override: %s), preserving names but no values', async override => {
        const home = await mkdtemp(join(tmpdir(), 'happier-claude-native-'));
        try {
            const configRoot = join(home, 'alternate');
            const project = join(home, 'project');
            await mkdir(configRoot);
            await mkdir(join(project, '.claude'), { recursive: true });
            const path = join(override ? configRoot : home, '.claude.json');
            await writeFile(path, JSON.stringify({
                mcpServers: { user: { command: 'user-bridge', args: ['--stdio'], env: { API_KEY: 'private-native-value' } } },
                projects: { [project]: { mcpServers: { local: { type: 'sse', url: 'https://example.test/sse', headers: { Authorization: 'private-native-value' } } }, disabledMcpServers: ['user'] },
                    [join(home, 'another-project')]: { mcpServers: { unrelated: { command: 'unrelated' } } } },
            }));
            await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'https://example.test/mcp' } } }));
            await writeFile(join(project, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { decoy: { command: 'not-native' } } }));
            const result = await readClaudeMcpConfigServers({ directory: project, env: { HOME: home, USERPROFILE: home, ...(override ? { CLAUDE_CONFIG_DIR: '~/alternate' } : {}) } });
            expect(result.warnings).toEqual([]);
            expect(result.servers).toEqual(expect.arrayContaining([
                expect.objectContaining({ name: 'user', transport: 'stdio', enabled: false, stdio: { command: 'user-bridge', args: ['--stdio'] }, envKeys: ['API_KEY'], source: { kind: 'user', path } }),
                expect.objectContaining({ name: 'local', transport: 'sse', remote: { url: 'https://example.test/sse', headers: ['Authorization'] }, source: { kind: 'project', path } }),
                expect.objectContaining({ name: 'shared', transport: 'http', source: { kind: 'project', path: join(project, '.mcp.json') } }),
            ]));
            expect(result.servers).toHaveLength(3);
            expect(JSON.stringify(result)).not.toContain('private-native-value');
        } finally { await rm(home, { recursive: true, force: true }); }
    });

    it('reports malformed native config instead of reporting a silently empty scan', async () => {
        const home = await mkdtemp(join(tmpdir(), 'happier-claude-native-'));
        try {
            await writeFile(join(home, '.claude.json'), '{');
            expect(await readClaudeMcpConfigServers({ directory: null, env: { HOME: home } })).toEqual({ servers: [], warnings: [{ provider: 'claude', code: 'parse_failed', path: join(home, '.claude.json') }] });
        } finally { await rm(home, { recursive: true, force: true }); }
    });
});
