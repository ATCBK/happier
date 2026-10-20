import { afterEach, expect, it, vi } from 'vitest';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { configuration } from '@/configuration';
import { createSessionAccountActionExecutor } from './createSessionAccountActionExecutor';
import { registerHappierMcpBuiltInTools } from '@/mcp/server/registerHappierMcpBuiltInTools';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { AgentRuntimeDaemonServiceRequestV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';

const processIdentity = vi.hoisted(() => vi.fn());
// Process inspection and runner→daemon HTTP are system boundaries. The real
// request parser, operation identity, store and conflict/recovery guards run.
vi.mock('@/daemon/processIdentity', () => ({ readProcessIdentityByPid: processIdentity }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('separates fresh Agent launches with reused MCP ids while same-key recovery returns the original settlement', async () => {
  const command = 'node /runtime/.runner-snapshots/request-identity/dist/index.mjs';
  const runner = { pid: process.pid, processStartTimeMs: 23_346,
    processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:request-identity' };
  processIdentity.mockResolvedValue({ pid: process.pid, processStartTimeMs: runner.processStartTimeMs, command });
  const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
  const sessionId = 'identity-parent';
  const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
    path, sessionId, runner, retainedAgent: createAgentSessionRunnerFactoryBinding({
      v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
      sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
      locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
      normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
    }) };
  await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31_001, capability: 'A'.repeat(43) });
  vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
  const witness = { turnId: 'identity-turn', inputId: 'identity-input', userMessageSeq: 1, userMessageSeqs: [1],
    agentStartCaller: { kind: 'session' as const, sessionId, starterDepth: 0, turnDepth: 0 } };
  const host = createHostActionOperationRuntime({ machineId: 'identity-machine', resolveAccountId: async () => 'identity-account' });
  let launches = 0;
  const ids: string[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(String(init?.body)));
    if (request.operation.kind !== 'action.execute') throw new Error('Expected Action request');
    const operation = request.operation;
    ids.push(operation.requestId);
    const outcome = await host.observeExecution({ actionId: operation.actionId, input: operation.input,
      actionRequestId: operation.requestId, sessionId: request.context.sessionId,
      // Physical child launch is the boundary. Its real retained settlement
      // must be returned without launching again on a same-key retry.
      execute: async () => ({ ok: true, result: { type: 'success', disposition: 'created',
        sessionId: `child-${++launches}`, executionTarget: { serverId: 'home', machineId: 'identity-machine' },
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } } }),
    });
    return new Response(JSON.stringify({ ok: true, result: { kind: 'action.execution', requestId: operation.requestId, outcome } }));
  });
  const create = () => {
    const executor = createSessionAccountActionExecutor({
      base: createCliActionExecutor({ token: '', sessionId, mode: 'plain', ctx: null }),
      client: { sessionId, getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://identity.test' }),
        rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
        getActiveTurnAdmissionWitness: () => witness },
    });
    const bridge = createActionToolExecutorBridge({ executor, surface: 'agent' });
    const handlers = new Map<string, (args: unknown, extra?: unknown) => Promise<unknown>>();
    registerHappierMcpBuiltInTools({ registerTool: (name, _meta, handler) => { handlers.set(name, handler); } }, {
      sessionId, surface: 'agent', deps: { ...bridge,
        resolveActionOptions: args => bridge.resolveActionOptions(args, sessionId),
        changeTitle: async () => ({ success: true }) },
    });
    const handler = handlers.get('action_execute');
    if (!handler) throw new Error('Missing real Action tool registration');
    return handler;
  };
  const input = (creationKey?: string) => SessionSpawnNewInputV2Schema.parse({
    ...(creationKey ? { creationKey } : {}), executionTarget: { serverId: 'home', machineId: 'identity-machine' },
    directory: { kind: 'path', path: '/workspace' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } },
    manager: { sessionId },
  });
  const invoke = async (executor: ReturnType<typeof create>, value: ReturnType<typeof input>, actionRequestId: string | number) => {
    const result = CallToolResultSchema.parse(await executor({ actionId: 'session.spawn_new', input: value }, { requestId: actionRequestId }));
    const text = result.content.find(block => block.type === 'text');
    if (text?.type !== 'text') throw new Error('Missing Action tool result');
    return { isError: result.isError, value: JSON.parse(text.text) as unknown };
  };
  try {
    const original = await invoke(create(), input('original-child'), 2);
    expect(original).toMatchObject({ isError: false, value: { sessionId: 'child-1' } });
    expect(await invoke(create(), input('fresh-child'), 2)).toMatchObject({ isError: false, value: { sessionId: 'child-2' } });
    witness.turnId = 'recovery-turn';
    expect(await invoke(create(), input('original-child'), '9')).toEqual(original);
    expect(await invoke(create(), { ...input('original-child'), directory: { kind: 'path', path: '/changed' } }, '10'))
      .toMatchObject({ isError: true, value: { errorCode: 'action_request_input_conflict' } });
    expect(launches).toBe(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[3]).toBe(ids[0]);
    // A new client may reuse its counter against the same live MCP server.
    // Without an explicit creation key these are distinct invocations.
    const connection = create();
    expect(await invoke(connection, input(), '2')).toMatchObject({ isError: false, value: { sessionId: 'child-3' } });
    expect(await invoke(connection, input(), '2')).toMatchObject({ isError: false, value: { sessionId: 'child-4' } });
    // The public key has no length cap; the private request id has a 512-character
    // envelope bound. A valid key beyond that bound must still reach its owner.
    expect(await invoke(connection, input('k'.repeat(513)), 2))
      .toMatchObject({ isError: false, value: { sessionId: 'child-5' } });
  } finally {
    await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('A'.repeat(43)) });
  }
});
