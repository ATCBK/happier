import { expect, it } from 'vitest';
import { assertMcpToolPolicyInvocation, runAgentMcpToolPolicyContract } from '@happier-dev/plugin-sdk/testing';
import { createDeclarativeAcpMcpPolicyFixtures, createGeminiMcpPolicyFixture, createPluginAcpMcpPolicyFixtures } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

runAgentMcpToolPolicyContract(createGeminiMcpPolicyFixture());
for (const fixture of await createDeclarativeAcpMcpPolicyFixtures()) runAgentMcpToolPolicyContract(fixture);
for (const fixture of await createPluginAcpMcpPolicyFixtures()) runAgentMcpToolPolicyContract(fixture);

it('detects the real composer miswire that lets a native session grant bypass live Off', async () => {
  await withTempDir('happier-acp-mcp-policy-miswire-', async cwd => {
    const input = createGeminiMcpPolicyFixture();
    const configuration = { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
      permissionIntent: { value: 'default' as const, updatedAtMs: 0 }, options: {} };
    const fixture = await input.fixtureServer.prepare({ cwd });
    let runtime: Awaited<ReturnType<typeof input.openSession>> | undefined;
    try {
      const projection = Object.fromEntries(fixture.servers.map(server => [server.key,
        { unlisted: 'ask' as const, tools: { [server.tool]: 'ask' as const } }]));
      const apply = async (setting: 'ask' | 'off') => input.fixtureServer.setPolicy({ runtime,
        permissionMode: 'default', settings: Object.fromEntries(fixture.servers.map(server => [server.key, setting])),
        projection, configuration });
      await apply('ask');
      // Deliberately omit only the host control projection at the actual leaf/composer
      // boundary. The real host catalog and permission owner remain intact.
      runtime = await input.openSession({ kind: 'create', sessionId: 'miswired-control-projection', cwd,
        configuration, mcpServers: Object.fromEntries(fixture.servers.map(server => [server.key, server.config])) });
      const server = fixture.servers[0];
      await input.invokeTool(runtime, { server: server.key, tool: server.tool, arguments: {}, approvalScope: 'session' });
      await apply('off');
      const before = input.fixtureServer.observeCalls().length;
      const invocation = await input.invokeTool(runtime, { server: server.key, tool: server.tool, arguments: {}, approvalScope: 'once' });
      expect(() => assertMcpToolPolicyInvocation({ expected: 'off', control: { off: 'blocked', approval: 'host' },
        server: server.key, serverId: server.serverId, tool: server.tool, invocation,
        calls: input.fixtureServer.observeCalls().slice(before) })).toThrow('denied tool cannot complete');
    } finally {
      try { await runtime?.dispose(); } finally { await input.fixtureServer.dispose(); }
    }
  });
});
