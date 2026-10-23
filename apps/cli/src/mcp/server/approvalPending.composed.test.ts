import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { executeContributedAction } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionSchemaReader } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { createPluginActionExecutor } from '@/session/actions/createDaemonPluginActionExecutor';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { projectExecutablePluginToolCatalog } from '@/plugins/runtime/toolCatalog';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createHappierToolInventory } from '@/agent/tools/happierTools/listBuiltInHappierTools';
import { prepareHappierMcpToolInventory, registerHappierMcpBuiltInTools } from './registerHappierMcpBuiltInTools';

describe('pending approval through real MCP and the shared native/plugin Action bridge', () => {
  const pluginId = 'acme.pending';
  const surfaces = ['agent', 'mcp', 'cli'] as const;
  let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | null = null;
  let executor: ReturnType<typeof createPluginActionExecutor> | null = null;
  let pluginToolCatalog: ReturnType<typeof projectExecutablePluginToolCatalog> = [];
  let created = 0;
  beforeAll(async () => {
    const inputSchema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false };
    const admitted = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      // Home/Machine identity is an external environment boundary. The runtime
      // still derives and validates replay placement from its admitted occurrence.
      runtimeOptions: { resolveCurrentMachineExecutionOriginContext: async () => ({
        serverIdentityId: 'pending-home', machineId: 'pending-machine',
      }) },
      plugins: [{
        manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
          actions: [{ id: 'publish', title: 'Publish label', scopes: ['global'], surfaces: ['agent', 'mcp', 'cli'],
            execution: { target: 'daemon' }, dangerLevel: 'writesRemote', confirmation: { title: 'Publish label' }, inputSchema }],
          tools: [{ id: 'other-tool', name: 'qa_pending_other', title: 'Other binding', action: 'publish',
            surfaces: ['mcp'], inputSchema, outputSchema: inputSchema },
          ...surfaces.map(surface => ({ id: `publish-${surface}`, name: `qa_pending_publish_${surface}`, title: 'Publish label', action: 'publish',
            surfaces: [surface], inputSchema, outputSchema: inputSchema }))],
        } }),
        files: { 'daemon.mjs': 'export function activate(api) { api.actions.register("publish", async () => { throw new Error("Unapproved handler must not run"); }); }' },
      }] });
    fixture = admitted;
    const runtime = admitted.registry;
    await runtime.activateContributionsOnDemand([{ pluginId, family: 'actions', localId: 'publish' }]);
    // The Artifact storage adapter uses a real temporary file. Subject creation,
    // policy, admission, activation, dispatch and MCP serialization stay real.
    const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
      create: async request => {
        const artifactId = `pending-${++created}`;
        await writeFile(join(admitted.happyHomeDir, `${artifactId}.json`), JSON.stringify(TargetActionApprovalRequestV1Schema.parse(request)));
        return { artifactId };
      },
      read: async artifactId => TargetActionApprovalRequestV1Schema.parse(JSON.parse(await readFile(join(admitted.happyHomeDir, `${artifactId}.json`), 'utf8'))),
    });
    // Match the retained-runtime MCP host: the plugin adapter admits dynamic
    // qualified ids before the built-in executor, and owns their result mapping.
    const discoveryScope = {
      tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({
        controller: admitted.controller, happyHomeDir: admitted.happyHomeDir,
      }),
    };
    const listContributedActionDefinitions = createCommittedContributedActionDefinitionLister(discoveryScope);
    executor = createPluginActionExecutor({
      base: createActionExecutor({
        listContributedActionDefinitions,
        readContributedActionSchemas: createCommittedContributedActionSchemaReader(listContributedActionDefinitions),
      }),
      requestPluginActionExecution: async (request, options) => executeContributedAction({
        runtimeRegistry: runtime, actionId: request.actionId, input: request.input, requestCurrentIntent,
        context: { surface: request.surface,
          ...(request.defaultSessionId ? { defaultSessionId: request.defaultSessionId } : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      }),
    });
    pluginToolCatalog = projectExecutablePluginToolCatalog(runtime);
  });
  afterAll(async () => { await fixture?.dispose(); });

  it.each(surfaces)('keeps the exact %s binding executable and its pending approval typed', async surface => {
      if (!fixture || !executor) throw new Error('Expected admitted plugin runtime');
      const runtime = fixture.registry;
      const before = created;
      const server = new McpServer({ name: 'pending-approval-test', version: '1.0.0' });
      const client = new Client({ name: 'pending-agent', version: '1.0.0' });
      try {
        const toolName = `qa_pending_publish_${surface}`;
        const bridge = createActionToolExecutorBridge({ surface, executor, registry: runtime.contributes, pluginToolCatalog });
        const inventory = createHappierToolInventory({ surface, registry: runtime.contributes, pluginToolCatalog });
        const expectedToolNames = (surface === 'mcp' ? ['qa_pending_other', toolName] : [toolName]).sort();
        expect(inventory.tools.filter(tool => tool.toolId?.startsWith(`${pluginId}/`)).map(tool => tool.name).sort())
          .toEqual(expectedToolNames);
        registerHappierMcpBuiltInTools(server, {
          sessionId: 'requesting-session', surface, pluginToolCatalog,
          // Exercise these real bindings and generic Action dispatch without
          // serializing every unrelated built-in schema on each surface.
          toolInventory: prepareHappierMcpToolInventory({ inventory: { ...inventory,
            tools: inventory.tools.filter(tool => tool.name === 'action_execute' || tool.toolId?.startsWith(`${pluginId}/`)),
          }, sessionId: 'requesting-session' }),
          deps: { ...bridge, changeTitle: async () => { throw new Error('Unexpected title change'); } },
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const listed = await client.listTools();
        expect(listed.tools.filter(tool => tool.name.startsWith('qa_pending_')).map(tool => tool.name).sort())
          .toEqual(expectedToolNames);
        const actionId = `${pluginId}/actions/publish`;
        const input = { label: 'Reviewed label' };
        for (const [name, args] of [
          [toolName, input],
          ['action_execute', { actionId, input }],
        ] as const) {
          const response = await client.callTool({ name, arguments: args });
          const content = response.content;
          if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected MCP text result');
          const payload: unknown = JSON.parse(content[0].text);
          const errorCode = payload && typeof payload === 'object' && 'errorCode' in payload ? payload.errorCode : null;
          expect.soft({ isError: response.isError, errorCode }, name).toEqual({ isError: false, errorCode: null });
          if (response.isError) continue;
          const pending = ActionApprovalRequestCreatedResultSchema.parse(payload);
          expect(pending).toMatchObject({ kind: 'approval_request_created', artifactId: `pending-${created}` });
          const stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(await readFile(join(fixture.happyHomeDir, `${pending.artifactId}.json`), 'utf8')));
          expect({ status: stored.status, actionId: stored.qualifiedActionId }).toEqual({ status: 'open', actionId });
          if (name === toolName) expect(response.structuredContent).toEqual(pending);
        }
        const native = await bridge.executeActionByToolName(toolName, input, 'requesting-session');
        expect(native, JSON.stringify(native)).toMatchObject({ ok: true });
        if (!native.ok) throw new Error(native.errorCode);
        expect(ActionApprovalRequestCreatedResultSchema.safeParse(native.result).success).toBe(true);
      } finally { await client.close(); await server.close(); }
      expect(created).toBe(before + 3);
  });
});
