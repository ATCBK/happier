import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readCodexMcpConfigServers } from './configServers.js';

describe('readCodexMcpConfigServers', () => {
    it('discovers inline tables and preserves escaped arguments through the canonical TOML parser', async () => {
        const configRoot = await mkdtemp(join(tmpdir(), 'codex-mcp-inline-'));
        await writeFile(join(configRoot, 'config.toml'), '[mcp_servers]\ninline = { command = "bridge", args = ["line\\nvalue", "quote\\\"value"], enabled = true }\n');
        const result = await readCodexMcpConfigServers({ env: { CODEX_HOME: configRoot } });
        expect(result.servers).toMatchObject([{ name: 'inline', stdio: { command: 'bridge', args: ['line\nvalue', 'quote"value'] }, enabled: true }]);
    });
    it('reads Codex MCP stdio servers from the final plugin agent path', async () => {
        const configRoot = await mkdtemp(join(tmpdir(), 'codex-mcp-config-'));
        await writeFile(
            join(configRoot, 'config.toml'),
            [
                '[mcp_servers.context7]',
                'command = "context7-mcp"',
                'args = ["--stdio"]',
                'enabled = true',
                '',
                '[mcp_servers."review.docs"]',
                'command = "review-mcp"',
                'args = ["--repo","."]',
                'enabled = false',
                '',
            ].join('\n'),
            'utf8',
        );

        const result = await readCodexMcpConfigServers({
            env: {
                CODEX_HOME: configRoot,
            },
        });

        expect(result.warnings).toEqual([]);
        expect(result.servers).toEqual([
            expect.objectContaining({
                provider: 'codex',
                name: 'context7',
                transport: 'stdio',
                stdio: {
                    command: 'context7-mcp',
                    args: ['--stdio'],
                },
                envKeys: [],
                enabled: true,
            }),
            expect.objectContaining({
                provider: 'codex',
                name: 'review.docs',
                transport: 'stdio',
                stdio: {
                    command: 'review-mcp',
                    args: ['--repo', '.'],
                },
                envKeys: [],
                enabled: false,
            }),
        ]);
    });
});
