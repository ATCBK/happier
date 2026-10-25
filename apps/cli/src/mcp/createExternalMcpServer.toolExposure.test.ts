import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { createExternalMcpServer } from './createExternalMcpServer';

async function listTools(actions: Record<string, unknown>) {
  vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions }));
  const { mcp, toolNames } = createExternalMcpServer({ credentials: { token: 'exposure-fixture', encryption: null } });
  const client = new Client({ name: 'standalone-exposure-contract', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      listed: (await client.request({ method: 'tools/list' }, ListToolsResultSchema)).tools.map(tool => tool.name).sort(),
      registered: [...toolNames].sort(),
    };
  } finally {
    await client.close();
    await mcp.close();
  }
}

// The full production Action catalog is the scale fixture. Adding ordinary
// Actions must not grow the default list compiled by every external MCP client.
const defaultToolNames = [
  'action_execute', 'action_options_resolve', 'action_spec_get', 'action_spec_search',
  'change_title', 'execution_run_get', 'execution_run_list', 'execution_run_wait',
  'plugins_reload', 'session_board_get', 'session_board_item_remove', 'session_board_item_upsert', 'skills_read', 'watch',
].sort();

describe('standalone MCP Action exposure', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('lists only the shared direct defaults rather than the full Action inventory', async () => {
    const { listed: names } = await listTools({});
    expect(names).toEqual(defaultToolNames);
    expect(names).toHaveLength(defaultToolNames.length);
  });

  it('lists watch whenever the standalone factory advertises it through listHappierMcpToolNames', async () => {
    const { listed, registered } = await listTools({});
    expect(registered).toContain('watch');
    expect(listed).toEqual(registered);
  });

  it('adds exactly one Action for an Account direct override', async () => {
    expect((await listTools({ 'session.status.get': { toolExposureModes: { mcp: 'direct' } } })).listed)
      .toEqual([...defaultToolNames, 'session_status_get'].sort());
  });

  it('removes an allow-listed direct Action for an Account discoverable-only override', async () => {
    expect((await listTools({ 'execution.run.list': { toolExposureModes: { mcp: 'discoverable_only' } } })).listed)
      .toEqual(defaultToolNames.filter(name => name !== 'execution_run_list'));
  });
});
