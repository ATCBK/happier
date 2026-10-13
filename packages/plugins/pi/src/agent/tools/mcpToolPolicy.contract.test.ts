import { runAgentMcpToolPolicyContract } from '@happier-dev/plugin-sdk/testing';
import { createPiMcpToolPolicyContractFixture } from './mcpToolPolicy.test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentExecutionRunRuntime, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';

runAgentMcpToolPolicyContract(createPiMcpToolPolicyContractFixture());

it('rejects a miswired native MCP approval correlation before host approval or server receipt', async () => {
  const input = createPiMcpToolPolicyContractFixture({ corruptNativeApprovalCorrelation: true });
  const cwd = await mkdtemp(join(tmpdir(), 'happier-pi-miswired-mcp-'));
  let runtime: AgentSessionRuntime | undefined;
  try {
    const fixture = await input.fixtureServer.prepare({ cwd });
    const policy = { a: { unlisted: 'ask' as const, tools: { echo: 'ask' as const } },
      b: { unlisted: 'ask' as const, tools: { echo: 'ask' as const } } };
    runtime = await input.openSession({ kind: 'create', sessionId: 'pi-miswired-mcp', cwd,
      mcpServers: Object.fromEntries(fixture.servers.map(server => [server.key, server.config])), mcpToolPolicy: policy });
    const invocation = await input.invokeTool(runtime, { server: 'a', tool: 'echo', arguments: {}, approvalScope: 'once' });
    expect(invocation).toEqual({ outcome: 'denied', permissions: [] });
    expect(input.fixtureServer.observeCalls()).toEqual([]);
  } finally {
    try { await runtime?.dispose(); }
    finally { await input.fixtureServer.dispose(); await rm(cwd, { recursive: true, force: true }); }
  }
});

it('delivers Run MCP through the same real extension and host permission handler', async () => {
  const input = createPiMcpToolPolicyContractFixture();
  const cwd = await mkdtemp(join(tmpdir(), 'happier-pi-run-mcp-contract-'));
  const runtimes: AgentExecutionRunRuntime[] = [];
  try {
    const fixture = await input.fixtureServer.prepare({ cwd });
    for (const setting of ['ask', 'off', 'allow'] as const) {
      const projection = { a: { unlisted: 'ask' as const, tools: { echo: setting === 'off' ? 'off' as const : 'ask' as const } },
        b: { unlisted: 'ask' as const, tools: { echo: 'ask' as const } } };
      await input.fixtureServer.setPolicy({ permissionMode: 'default', settings: { a: setting, b: 'ask' }, projection,
        configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {} } });
      const beforeCalls = input.fixtureServer.observeCalls().length;
      const beforePermissions = input.observePermissions().length;
      const runtime = await input.openRun({ kind: 'create', runId: `pi-mcp-${setting}`, cwd,
        profile: { pluginId: 'fixture', localId: 'profile' },
        input: { text: 'happier-fixture:{"name":"mcp__a__echo","args":{}}' },
        mcpServers: Object.fromEntries(fixture.servers.map(server => [server.key, server.config])), mcpToolPolicy: projection });
      runtimes.push(runtime);
      await new Promise<void>((resolve, reject) => runtime.watch(event => {
        if (event.kind === 'run-complete') resolve();
        if (event.kind === 'run-failed' || event.kind === 'run-cancelled') reject(new Error(JSON.stringify(event)));
      }));
      const calls = input.observeServerCalls().slice(beforeCalls);
      const permissions = input.observePermissions().slice(beforePermissions);
      if (setting === 'off') {
        expect(calls).toEqual([]);
        expect(permissions).toEqual([]);
      } else {
        expect(calls).toHaveLength(1);
        expect(calls[0]!.privateTokenDelivered).toBe(true);
        expect(permissions).toEqual([expect.objectContaining({ server: 'a', serverId: 'catalog-a', tool: 'echo',
          decision: 'approved', prompted: setting === 'ask' })]);
        expect(permissions[0]!.order).toBeLessThan(calls[0]!.order);
      }
      await runtime.dispose();
    }
  } finally {
    try { for (const runtime of runtimes) await runtime.dispose(); }
    finally { await input.fixtureServer.dispose(); await rm(cwd, { recursive: true, force: true }); }
  }
});
