import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { runAgentMcpToolPolicyContract } from '../../../../plugin-sdk/src/testing/mcpToolPolicyContract.js';
import { createAcpMcpPolicyFixture } from '@/agent/acp/testkit/mcpToolPolicyHarness';
import { createKiloAgentRuntime } from './runtime/factory.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSessionConfigurationSnapshotV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { projectMcpToolLaunchPolicyV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import type { AgentRuntimeFactory, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';

const injectiveIdentity = { serverKeys: ['team-docs', 'team-archive'], toolNames: ['echo'] } as const;

const parsed = parsePluginManifest(PLUGIN_MANIFEST);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
const agent = parsed.manifest.contributes.agents?.find(agent => agent.id === 'kilo');
if (!agent) throw new Error('Missing authored Kilo Agent');
describe('Kilo mode-generated permission environment', () => runAgentMcpToolPolicyContract(createAcpMcpPolicyFixture({
  agent, pluginId: parsed.manifest.id, factory: createKiloAgentRuntime, toolWireFormat: 'underscore', ...injectiveIdentity,
})));

// Caller-owned native permission environments are an existing product path.
// This characterization does not stand in for the mode-generated launch above.
describe('Kilo caller-owned permission environment', () => runAgentMcpToolPolicyContract(createAcpMcpPolicyFixture({
  agent, pluginId: parsed.manifest.id, toolWireFormat: 'underscore', ...injectiveIdentity,
  async factory(context) {
    const runtime = await createKiloAgentRuntime(context);
    return { ...runtime, sessions: { ...runtime.sessions,
      open(request, host) {
        return runtime.sessions.open({ ...request, launchEnvironment: {
          values: { ...request.launchEnvironment?.values, KILO_PERMISSION: '{"*":"ask"}' },
          unset: (request.launchEnvironment?.unset ?? []).filter(key => key !== 'KILO_PERMISSION'),
        } }, host);
      },
    } };
  },
})));

describe('Kilo raw MCP identity refusal through the factory and ACP host', () => {
  let cwd: string | undefined;
  let runtime: AgentSessionRuntime | undefined;
  let fixture: ReturnType<typeof createAcpMcpPolicyFixture> | undefined;
  // An explicit test-only wiring mutation proves the deciding assertions fail
  // when the production factory's resolver is omitted from the ACP composition.
  const factory: AgentRuntimeFactory = async context => {
    const native = await createKiloAgentRuntime(context);
    if (process.env.HAPPIER_KILO_IDENTITY_MISWIRE !== '1') return native;
    return { ...native, sessions: { ...native.sessions,
      open(request, host) {
        return native.sessions!.open(request, { ...host, protocols: { ...host.protocols,
          acp: { ...host.protocols.acp, open(openRequest, options) {
            return host.protocols.acp.open(openRequest, { ...options,
              definition: { ...options.definition, toolNameResolver: undefined } });
          } },
        } });
      },
    } };
  };
  const configuration = AgentSessionConfigurationSnapshotV1Schema.parse({
    mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
    permissionIntent: { value: 'default', updatedAtMs: 0 }, options: {},
  });
  afterEach(async () => {
    try { await runtime?.dispose(); }
    finally { try { await fixture?.fixtureServer.dispose(); }
      finally { if (cwd) await rm(cwd, { recursive: true, force: true }); } }
  });

  it('refuses dotted and colliding tools without a birth snapshot before and after same-mode live Off', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'happier-kilo-identity-'));
    fixture = createAcpMcpPolicyFixture({ agent, pluginId: parsed.manifest.id, factory,
      toolWireFormat: 'underscore', serverKeys: ['docs', 'archive'], toolNames: ['file.read', 'file_read', 'echo'],
      initialToolDefault: 'allow_all' });
    const servers = (await fixture.fixtureServer.prepare({ cwd })).servers;
    const projection = Object.fromEntries(servers.map(server => [server.key, projectMcpToolLaunchPolicyV1({
      policy: { default: 'allow_all', overrides: {} }, snapshot: undefined, permissionMode: 'default',
    })]));
    expect(Object.values(projection).every(policy => Object.keys(policy.tools).length === 0)).toBe(true);
    runtime = await fixture.openSession({ kind: 'create', sessionId: 'kilo-raw-identity', cwd, configuration,
      mcpServers: Object.fromEntries(servers.map(server => [server.key, server.config])), mcpToolPolicy: projection });
    expect((await fixture.invokeTool(runtime, { server: 'docs', tool: 'echo', arguments: {}, approvalScope: 'once' })).outcome).toBe('completed');
    const before = fixture.fixtureServer.observeCalls().length;
    for (const tool of ['file.read', 'file_read']) {
      expect((await fixture.invokeTool(runtime, { server: 'docs', tool, arguments: {}, approvalScope: 'once' })).outcome).toBe('denied');
    }
    await fixture.fixtureServer.setPolicy({ runtime, permissionMode: 'default', settings: { docs: 'off' },
      projection, configuration });
    expect((await fixture.invokeTool(runtime, { server: 'docs', tool: 'file.read', arguments: {}, approvalScope: 'once' })).outcome).toBe('denied');
    expect(fixture.fixtureServer.observeCalls().slice(before)).toEqual([]);
    expect((await fixture.invokeTool(runtime, { server: 'archive', tool: 'echo', arguments: {}, approvalScope: 'once' })).outcome).toBe('completed');
  });

  it('refuses colliding server aliases before either real server receives a call', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'happier-kilo-identity-'));
    fixture = createAcpMcpPolicyFixture({ agent, pluginId: parsed.manifest.id, factory,
      toolWireFormat: 'underscore', serverKeys: ['docs.team', 'docs_team'], toolNames: ['echo'],
      initialToolDefault: 'allow_all' });
    const servers = (await fixture.fixtureServer.prepare({ cwd })).servers;
    runtime = await fixture.openSession({ kind: 'create', sessionId: 'kilo-server-identity', cwd, configuration,
      mcpServers: Object.fromEntries(servers.map(server => [server.key, server.config])),
      mcpToolPolicy: Object.fromEntries(servers.map(server => [server.key, projectMcpToolLaunchPolicyV1({
        policy: { default: 'allow_all', overrides: {} }, snapshot: undefined, permissionMode: 'default',
      })])) });
    for (const server of servers) {
      expect((await fixture.invokeTool(runtime, { server: server.key, tool: 'echo', arguments: {}, approvalScope: 'once' })).outcome).toBe('denied');
    }
    expect(fixture.fixtureServer.observeCalls()).toEqual([]);
  });
});
