import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preparePiHappierToolsExtension } from './assets.js';

describe('Pi private user MCP config', () => {
  it('carries the open-request servers in the private config and removes it on dispose', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-mcp-assets-'));
    try {
      const mcpServers = { example: { command: '/managed/server', args: ['serve'], env: { TOKEN: 'fixture' } } };
      const prepared = await preparePiHappierToolsExtension({
        agentDir: root,
        config: { v: 1, sessionId: 'session', directory: root, systemPrompt: '', tools: [],
          launch: { executablePath: '/managed/happier', argsPrefix: [] } },
        mcpServers,
      });
      try {
        expect(JSON.parse(readFileSync(prepared.configPath, 'utf8')).mcpServers).toEqual(mcpServers);
        if (process.platform !== 'win32') expect(statSync(prepared.configPath).mode & 0o777).toBe(0o600);
      } finally {
        await prepared.dispose();
      }
      expect(existsSync(prepared.configPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
