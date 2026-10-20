import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/mini';

import { logger } from '@/ui/logger';
import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

describe('MCP invalid plugin tool isolation', () => {
  it.each([
    { inputSchema: false },
    { inputSchema: { type: 'object', properties: { scope: { type: 'unsupported' } } } },
    { inputSchema: { type: 'object' }, outputSchema: false },
  ])('keeps initialize, discovery and healthy dispatch available with an attributed diagnostic (%j)', async schemas => {
    const healthy = { name: 'change_title', title: 'Change title', description: 'Change title', inputSchema: z.strictObject({ title: z.string() }) };
    const id = 'outputSchema' in schemas ? 'invalid-output' : typeof schemas.inputSchema === 'boolean' ? 'invalid-input' : 'invalid-vocabulary';
    const invalid = { ...healthy, name: id, toolId: `acme.plugin/${id}`, actionId: `acme.plugin/${id}`, ...schemas };
    const inventory = { tools: [invalid, healthy], actionToolNameToId: new Map([[invalid.name, invalid.actionId]]) };
    const prepared = prepareHappierMcpToolInventory({ inventory, sessionId: 'sess-1' });
    const server = new McpServer({ name: 'invalid-plugin-test', version: '1' });
    const { toolNames } = registerHappierMcpBuiltInTools(server, {
      sessionId: 'sess-1', surface: 'mcp', toolInventory: prepared,
      deps: { changeTitle: async () => ({ success: true }), executeActionByToolName: async () => ({ ok: true, result: { healthy: true } }) },
    });
    const client = new Client({ name: 'invalid-plugin-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual(['change_title']);
      expect(toolNames).toEqual(['change_title']);
      expect(prepared.actionToolNameToId.has(invalid.name)).toBe(false);
      expect(await client.callTool({ name: 'change_title', arguments: { title: 'Healthy' } })).toMatchObject({ isError: false });
      expect(await client.callTool({ name: invalid.name, arguments: {} })).toMatchObject({ isError: true });
      logger.flushSync();
      const log = await readFile(logger.logFilePath, 'utf8');
      expect(log).toContain(invalid.toolId);
      expect(log).toContain('action_schema_invalid');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
