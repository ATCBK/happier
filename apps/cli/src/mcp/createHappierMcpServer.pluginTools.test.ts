import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import fastify from 'fastify';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { writeStoredCredentialsForServerId } from '@/persistence';
import type { HappyMcpSessionClient } from './startHappyServer';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

const boundary = vi.hoisted(() => ({
  daemonPost: vi.fn(async () => ({ matched: true, result: { ok: true, result: { completed: true } } })),
}));
// Daemon HTTP is the only substituted system boundary; the MCP SDK,
// registration, Action bridge, executor and control-client parser remain real.
vi.mock('@/daemon/controlHttp', () => ({ daemonPost: boundary.daemonPost }));
afterEach(() => boundary.daemonPost.mockClear());

import { createHappierMcpServer } from './createHappierMcpServer';
import { filterPluginToolsForActiveAgentComposition } from './startHappyServer';
import { PLUGIN_ACTION_EXECUTE_PATH } from '@/plugins/daemon/controlRoutes';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

function sessionClient(sessionId: string): HappyMcpSessionClient {
  return {
    sessionId,
    getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
    rpcHandlerManager: new RpcHandlerManager({ scopePrefix: sessionId, encryptionMode: 'plain' }),
    updateMetadata() {},
    getWorkDepth: () => 0,
    getHostTurnWorkDepth: turnId => turnId === 'plugin-tool-turn' ? 0 : undefined,
    getActiveTurnPermissionWitness: () => ({ turnId: 'plugin-tool-turn',
      causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' } }),
  };
}

describe('createHappierMcpServer plugin tools', () => {
  it('executes an authored Account Action from the native Agent tool entry without a Machine', async () => {
    await withTempDir('happier-agent-account-', async homeDir => {
      const originalEnv = process.env;
      process.env = { ...originalEnv, HAPPIER_HOME_DIR: homeDir };
      reloadConfiguration();
      const app = fastify();
      const endpoint = 'http://session-account.test';
      const accountId = 'session-account-owner';
      const features = registerAccountHomeHttp(app, { accountId, serverId: 'session-account' });
      const { pluginId } = await registerAuthoredAccountActionRelease(app, accountId);
      await app.ready();
      const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
      const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
      await writeStoredCredentialsForServerId('session-account', credentials);
      const { mcp, executeTool } = createHappierMcpServer({ ...sessionClient('session-account-agent'),
        getServerBinding: () => ({ serverId: 'session-account', serverUrl: endpoint }),
        getServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features }),
      }, { credentials, pluginToolCatalog: [] });
      boundary.daemonPost.mockClear();
      try {
        const result = await executeTool({ toolName: 'action_execute', args: {
          actionId: 'action.invoke', input: { action: { pluginId, localId: 'echo' }, input: { key: 'agent' } },
        } });
        expect(result).toMatchObject({ ok: true, result: { key: 'agent', surface: 'agent' } });
        await writeStoredCredentialsForServerId('session-account', { ...credentials, token: 'replacement-account' });
        const retired = await executeTool({ toolName: 'action_execute', args: {
          actionId: 'action.invoke', input: { action: { pluginId, localId: 'echo' }, input: { key: 'retired' } },
        } });
        expect(retired).toMatchObject({ ok: false, errorCode: 'plugin_action_generation_retired' });
        expect(boundary.daemonPost).not.toHaveBeenCalled();
      } finally { restore(); await mcp.close(); await app.close(); process.env = originalEnv; reloadConfiguration(); }
    });
  });

  it('advertises and dispatches a daemon-projected tool through real session-agent MCP wiring', async () => {
    const entry = {
      toolId: 'acme.review.plugin/review-tool', actionId: 'acme.review.plugin/actions/review-start',
      name: 'acme_review_start', title: 'Review', description: 'Start a plugin-defined review workflow',
      inputSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { completed: { type: 'boolean' } }, required: ['completed'], additionalProperties: false },
      surfaces: ['agent', 'mcp', 'cli'],
    } satisfies ProjectedPluginToolCatalogEntry;
    const { mcp } = createHappierMcpServer(sessionClient('sess_agent_plugin_tool_1'), { pluginToolCatalog: [entry] });
    const client = new Client({ name: 'session-plugin-tools-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const advertised = listed.tools.find(tool => tool.name === entry.name);
      expect(advertised).toMatchObject({ inputSchema: entry.inputSchema });
      // Registration composes completed output with the canonical approval
      // envelope; the real SDK validates the completed structured result below.
      expect(advertised?.outputSchema).toBeDefined();
      const result = CallToolResultSchema.parse(await client.callTool({ name: entry.name, arguments: { scope: 'diff' } }));
      expect(result).toEqual({ content: [{ type: 'text', text: '{"completed":true}' }],
        structuredContent: { completed: true }, isError: false });
      const action = parseQualifiedPluginActionId(entry.actionId);
      if (!action) throw new Error('Expected qualified plugin Action');
      expect(boundary.daemonPost).toHaveBeenCalledWith(PLUGIN_ACTION_EXECUTE_PATH, expect.objectContaining({
        actionId: buildQualifiedPluginContributionKey(action), input: { scope: 'diff' }, surface: 'agent', startedBy: 'agent',
        defaultSessionId: 'sess_agent_plugin_tool_1',
      }), expect.objectContaining({ mutation: true, timeoutMs: null, signal: expect.any(AbortSignal) }));
    } finally { await client.close(); await mcp.close(); }
  });

  it('advertises only selected tools for a composition-managed plugin to the actual MCP client', async () => {
    const catalog = [{
      toolId: 'acme.composition/selected-tool', actionId: 'acme.composition/actions/selected-action',
      name: 'acme_composition_selected', title: 'Selected', description: 'The selected composition tool.',
      inputSchema: { type: 'object', additionalProperties: false }, safety: 'safe', surfaces: ['agent'],
    }, {
      toolId: 'acme.composition/unselected-tool', actionId: 'acme.composition/actions/unselected-action',
      name: 'acme_composition_unselected', title: 'Unselected', description: 'The unselected composition tool.',
      inputSchema: { type: 'object', additionalProperties: false }, safety: 'safe', surfaces: ['agent'],
    }, {
      toolId: 'acme.unmanaged/always-visible-tool', actionId: 'acme.unmanaged/actions/always-visible-action',
      name: 'acme_unmanaged_visible', title: 'Unmanaged', description: 'A tool without composition ownership.',
      inputSchema: { type: 'object', additionalProperties: false }, safety: 'safe', surfaces: ['agent'],
    }] as const satisfies readonly ProjectedPluginToolCatalogEntry[];
    for (const selected of [true, false]) {
      const { mcp } = createHappierMcpServer(sessionClient('sess_agent_composition_tool_1'), {
        pluginToolCatalog: filterPluginToolsForActiveAgentComposition(catalog, {
          managedPluginIds: ['acme.composition'],
          selectedTools: selected ? [{ pluginId: 'acme.composition', localId: 'selected-tool' }] : [],
          selectedToolBindings: selected ? [{ tool: catalog[0], expectedContributorOccurrenceId: 'occurrence-g' }] : [],
        }),
      });
      const client = new Client({ name: 'composition-tools-test', version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await mcp.connect(serverTransport);
        await client.connect(clientTransport);
        const names = (await client.listTools()).tools.map(tool => tool.name);
        expect(names.includes('acme_composition_selected')).toBe(selected);
        expect(names).not.toContain('acme_composition_unselected');
        expect(names).toContain('acme_unmanaged_visible');
      } finally { await client.close(); await mcp.close(); }
    }
  });
});
