import { expect, it } from 'vitest';
import { assertMcpToolPolicyInvocation, runAgentMcpToolPolicyContract } from '../../../../../../../packages/plugin-sdk/src/testing/mcpToolPolicyContract';
import { createDeclarativeAcpMcpPolicyFixtures, createGeminiMcpPolicyFixture, createPluginAcpMcpPolicyFixtures } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createGeminiAgentRuntime } from '../../../../../../../packages/plugins/gemini/src/agent/runtime/factory';

runAgentMcpToolPolicyContract(createGeminiMcpPolicyFixture());
for (const fixture of await createDeclarativeAcpMcpPolicyFixtures()) runAgentMcpToolPolicyContract(fixture);
for (const fixture of await createPluginAcpMcpPolicyFixtures()) runAgentMcpToolPolicyContract(fixture);

it('detects a missing native identity codec at the real Gemini factory/composer seam', async () => {
  await withTempDir('happier-acp-mcp-policy-miswire-', async cwd => {
    const input = createGeminiMcpPolicyFixture(undefined, async context => {
      const leaf = await createGeminiAgentRuntime(context);
      if (!leaf.sessions) throw new Error('Missing real Gemini session factory');
      const sessions = leaf.sessions;
      return { ...leaf, sessions: { ...sessions, open(request, host) {
        return sessions.open(request, { ...host, protocols: { ...host.protocols, acp: { ...host.protocols.acp,
          open(prepared, options) {
            return host.protocols.acp.open(prepared, { ...options,
              definition: { ...options.definition, toolNameResolver: undefined } });
          },
        } } });
      } } };
    });
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
      // Drop only the leaf codec at the actual factory/composer boundary. The
      // production launch, real catalog, policy and permission handler stay intact.
      runtime = await input.openSession({ kind: 'create', sessionId: 'miswired-control-projection', cwd,
        configuration, mcpToolPolicy: projection,
        mcpServers: Object.fromEntries(fixture.servers.map(server => [server.key, server.config])) });
      const server = fixture.servers[0];
      const before = input.fixtureServer.observeCalls().length;
      const invocation = await input.invokeTool(runtime, { server: server.key, tool: server.tool, arguments: {}, approvalScope: 'once' });
      expect(() => assertMcpToolPolicyInvocation({ expected: 'ask', control: { off: 'blocked', approval: 'host' },
        server: server.key, serverId: server.serverId, tool: server.tool, invocation,
        calls: input.fixtureServer.observeCalls().slice(before) })).toThrow('real call reaches the host permission handler');
    } finally {
      try { await runtime?.dispose(); } finally { await input.fixtureServer.dispose(); }
    }
  });
});
