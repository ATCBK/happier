import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { preparePiHappierToolsExtension } from './assets.js';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

describe('Pi private user MCP config', () => {
  it('carries the open-request servers in the private config and removes it on dispose', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-mcp-assets-'));
    try {
      const mcpServers = { example: { command: '/managed/server', args: ['serve'], env: { TOKEN: 'fixture' } } };
      const mcpToolPolicy = { example: { unlisted: 'ask', tools: { read: 'allow', write: 'off' } } }
        satisfies NonNullable<AgentSessionOpenRequest['mcpToolPolicy']>;
      const prepared = await preparePiHappierToolsExtension({
        agentDir: root,
        config: { v: 1, sessionId: 'session', directory: root, systemPrompt: '', tools: [],
          launch: { executablePath: '/managed/happier', argsPrefix: [] } },
        mcpServers,
        mcpToolPolicy,
      });
      try {
        expect(JSON.parse(readFileSync(prepared.configPath, 'utf8')).mcpServers).toEqual(mcpServers);
        expect(JSON.parse(readFileSync(prepared.configPath, 'utf8')).mcpToolPolicy).toEqual(mcpToolPolicy);
        if (process.platform !== 'win32') expect(statSync(prepared.configPath).mode & 0o777).toBe(0o600);
      } finally {
        await prepared.dispose();
      }
      expect(existsSync(prepared.configPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prepares Run MCP without a Session bridge or invented Session identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-pi-run-mcp-assets-'));
    let prepared: Awaited<ReturnType<typeof preparePiHappierToolsExtension>> | undefined;
    try {
      prepared = await preparePiHappierToolsExtension({ agentDir: root, directory: root,
        mcpServers: { run: { command: '/managed/server', args: [] } },
        mcpToolPolicy: { run: { unlisted: 'ask', tools: { echo: 'ask' } } } });
      const config = JSON.parse(readFileSync(prepared.configPath, 'utf8'));
      expect(config).toMatchObject({ v: 1, directory: root, tools: [],
        mcpServers: { run: { command: '/managed/server', args: [] } },
        mcpToolPolicy: { run: { unlisted: 'ask', tools: { echo: 'ask' } } } });
      expect(config).not.toHaveProperty('sessionId');
      expect(config).not.toHaveProperty('launch');
      expect(prepared.toolNames).toEqual([]);
    } finally {
      await prepared?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
