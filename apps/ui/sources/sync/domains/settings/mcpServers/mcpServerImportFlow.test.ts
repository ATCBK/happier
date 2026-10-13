import { describe, expect, it } from 'vitest';
import { prepareDetectedMcpServerImportV1, materializeMcpServerImportV1 } from '@happier-dev/protocol/mcp/servers/import/mcpServerImportV1';

describe('MCP Found value admission', () => {
    it('refuses a detected key instead of silently committing a machine placeholder', async () => {
        const result = await materializeMcpServerImportV1({
            catalog: { servers: [] }, parsed: prepareDetectedMcpServerImportV1([
                { provider: 'claude', name: 'one', transport: 'stdio', stdio: { command: 'tool', args: [] },
                    envKeys: ['API_KEY'], enabled: true, source: { kind: 'user', path: '/config.json' } },
            ], 'machine-1'), nowMs: 1, newId: () => 'id-1',
            createSecret: async () => { throw new Error('secret mutation must not run'); },
        });
        expect(result).toMatchObject({ ok: false, missingValues: [{ inputId: 'one:env:API_KEY' }] });
    });
});
