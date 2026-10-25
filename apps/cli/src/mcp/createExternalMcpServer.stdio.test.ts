import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol';
import { LocalServiceActionRequestV1Schema } from '@happier-dev/protocol/local/services/actions/v1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { createExternalMcpServer } from './createExternalMcpServer';

describe('standalone MCP stdio startup', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('initializes and discovers Local Service tools after their shared input has been parsed', async () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions: {
      'localServices.actions.openPreview': { toolExposureModes: { mcp: 'direct' } },
    } }));
    LocalServiceActionRequestV1Schema.parse({ requestId: 'stdio-review', action: 'open_preview',
      target: { kind: 'inventory_entry', inventoryEntryId: 'detected', machineId: 'source' } });
    const { mcp } = createExternalMcpServer({
      credentials: { token: 'stdio-fixture', encryption: null, credentialProvenance: 'stored_session' },
      machineId: 'source', daemonControlTarget: null,
      serverFeaturesSnapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: {
        localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true },
          actions: { enabled: true }, managed: { enabled: true } },
        browser: { enabled: true, viewTargets: { enabled: true } },
      }, capabilities: {} }) },
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const readBuffer = new ReadBuffer();
    // Replace only process pipes. Both protocol peers, the stdio server's
    // framing, Action inventory, schema projection and registration stay real.
    const transport: Transport = {
      async start() {
        stdout.on('data', chunk => {
          readBuffer.append(chunk);
          let message;
          while ((message = readBuffer.readMessage()) !== null) transport.onmessage?.(message);
        });
      },
      async send(message) { stdin.write(serializeMessage(message)); },
      async close() { stdout.removeAllListeners('data'); readBuffer.clear(); transport.onclose?.(); },
    };
    const client = new Client({ name: 'standalone-stdio-regression', version: '1' });
    try {
      await mcp.connect(new StdioServerTransport(stdin, stdout));
      await client.connect(transport);
      // The SDK consumes and compiles every advertised output schema here.
      const { tools } = await client.listTools();
      expect(tools).toContainEqual(expect.objectContaining({
        name: getActionSpec('localServices.actions.openPreview').bindings?.mcpToolName,
        inputSchema: expect.objectContaining({ type: 'object', properties: expect.objectContaining({
          requestId: expect.any(Object), target: expect.any(Object), action: expect.any(Object),
        }) }),
      }));
    } finally {
      await client.close();
      await mcp.close();
      stdin.destroy();
      stdout.destroy();
    }
  });
});
