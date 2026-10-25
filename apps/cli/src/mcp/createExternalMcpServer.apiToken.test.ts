import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createExternalMcpServer } from './createExternalMcpServer';

describe('createExternalMcpServer with an API token', () => {
  it('routes the advertised MCP Session Action through the real PAT executor and HTTP transport', async () => {
    const token = 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43);
    const sessionId = 'c123456789012345678901234';
    const spec = getActionSpec('session.status.get');
    if (!spec.outputSchema) throw new Error('Session status must declare its public output');
    const status = spec.outputSchema.parse({ session: { id: sessionId, createdAt: 1, updatedAt: 2, active: true, activeAt: 2, encryption: null } });
    const app = Fastify();
    const requests: unknown[] = [];
    // Home HTTP is the genuine system boundary. MCP registration, the Action
    // bridge, PAT executor, SDK, target selection and schemas all stay real.
    app.post('/v1/actions/session.status.get', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      const envelope = ExternalActionRequestEnvelopeSchema.parse(request.body);
      requests.push(envelope);
      expect(envelope).toMatchObject({ v: 1, target: { kind: 'session', sessionId }, input: { sessionId } });
      return { v: 1, actionId: spec.id, requestId: envelope.requestId, execution: { ok: true, result: status } };
    });
    const endpoint = await app.listen({ port: 0, host: '127.0.0.1' });
    const pluginToolCatalog = [{
      toolId: 'acme.review.plugin/review-tool', actionId: 'acme.review.plugin/review-start',
      name: 'acme_review_start', title: 'Review', description: 'A local-only plugin Action',
      inputSchema: { type: 'object' }, surfaces: ['mcp'],
    }] satisfies readonly ProjectedPluginToolCatalogEntry[];
    const { mcp } = runWithServerHttpBaseUrl(endpoint, () => createExternalMcpServer({
      credentials: { token, encryption: null, credentialProvenance: 'api_token' },
      defaultSessionId: sessionId, pluginToolCatalog,
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'pat-mcp-test', version: '1' });
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toContain('session_status_get');
      expect(tools.tools.map(tool => tool.name)).not.toContain('acme_review_start');
      const response = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute',
        arguments: { actionId: 'session.status.get', input: {} } }));
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const text = response.content.find(content => content.type === 'text');
      expect(text?.type === 'text' ? JSON.parse(text.text) : null).toEqual(status);
      expect(requests).toHaveLength(1);
      // The generic action_execute tool has no fixed output schema. The typed
      // tool publishes this Action's declared structured output to MCP clients.
      const direct = CallToolResultSchema.parse(await client.callTool({ name: 'session_status_get', arguments: {} }));
      expect(direct.isError, JSON.stringify(direct)).not.toBe(true);
      expect(direct.structuredContent).toEqual(status);
      expect(requests).toHaveLength(2);
    } finally {
      await client.close();
      await mcp.close();
      await app.close();
    }
  });
});
