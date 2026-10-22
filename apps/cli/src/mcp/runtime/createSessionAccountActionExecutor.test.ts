import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createSessionAccountActionExecutor } from './createSessionAccountActionExecutor';
import { configuration } from '@/configuration';
import { NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { hashProcessCommand } from '@/daemon/sessionRegistry';
import { hashPrivateBearer } from '@/daemon/privateBearerFile';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
  removeAgentRuntimeDaemonServiceAuthorityIfOwned } from '@/daemon/agentRuntime/sessionBridgeAuthorization';

const processIdentity = vi.hoisted(() => vi.fn());
// OS process inspection is the boundary; the real command-identity parser is retained.
vi.mock('@/daemon/processIdentity', () => ({ readProcessIdentityByPid: processIdentity }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const createRestrictedExecutor = () => createCliActionExecutor({
  token: '', sessionId: 'caller-session', mode: 'plain', ctx: null,
});

describe('Session MCP Account routing', () => {
  it('does not turn an implicit Session workspace into Machine-wide saved inventory authority', async () => {
    const executor = createSessionAccountActionExecutor({ base: createRestrictedExecutor(), client: {
      sessionId: 'caller-session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
      rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
    } });
    expect(await executor.execute('scm.diffSummary.result.list', {}, { surface: 'agent', defaultSessionId: 'caller-session' }))
      .toMatchObject({ ok: false, errorCode: 'machine_not_selected' });
  });
  it('refuses unavailable daemon authority instead of executing with the session bearer', async () => {
    vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', '');
    const executor = createSessionAccountActionExecutor({
      base: createRestrictedExecutor(),
      client: {
        sessionId: 'caller-session',
        getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
        rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} },
        updateMetadata() {},
      },
    });
    const result = await executor.execute('notifications.notify_me', { message: 'Notify' }, { surface: 'agent' });
    expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  });

  it.each([
    { actionId: 'notifications.notify_me' as const, input: { message: 'Notify' }, uncertain: false },
    { actionId: 'notifications.notify_me' as const, input: { message: 'Notify' }, uncertain: true },
    { actionId: 'session.list' as const, input: {}, uncertain: false },
    { actionId: 'agents.models.list' as const, input: { backendTargetKey: 'agent:acme.discovery/assistant', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'agents.config_options.list' as const, input: { backendTargetKey: 'agent:acme.discovery/assistant', machineId: 'shared-machine', modelId: 'small' }, uncertain: false },
    { actionId: 'agents.session_modes.list' as const, input: { backendTargetKey: 'agent:acme.discovery/assistant', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'action.options.resolve' as const, input: { actionId: 'execution.run.start', fieldPath: 'configOptions',
      draftInput: { backendTargetKey: 'agent:acme.discovery/assistant', machineId: 'shared-machine', modelId: 'small' } }, uncertain: false },
    { actionId: 'session.activity.get' as const, input: { sessionId: 'caller-session' }, uncertain: false },
    { actionId: 'scm.diff.file' as const, input: { cwd: '/run/workspace', path: 'file.ts' }, uncertain: false },
    { actionId: 'scm.file.read' as const, input: { cwd: '/run/workspace', path: 'file.ts', selector: { side: 'before', area: 'pending' } }, uncertain: false },
    { actionId: 'scm.blame.get' as const, input: { cwd: '/run/workspace', path: 'file.ts' }, uncertain: false },
    { actionId: 'session.transcript.get' as const, input: { sessionId: 'caller-session', limit: 10 }, uncertain: false },
    { actionId: 'session.notes.set' as const, input: { sessionId: 'led-child', notes: 'Delegated notes' }, uncertain: false },
    { actionId: 'session.roles.apply_to_reports' as const, input: { sessionId: 'caller-session' }, uncertain: false },
    { actionId: 'execution.run.start' as const, input: { intent: 'task',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      instructions: 'Reply only', modelId: 'gpt-6-luna', configOptions: { reasoning_effort: 'low' },
      permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
    }, uncertain: false },
    { actionId: 'subagents.delegate.start' as const, input: {
      backendTargetKeys: ['agent:acme.discovery/assistant'], instructions: 'Reply only',
    }, uncertain: false },
    { actionId: 'session.spawn_new' as const, input: {
      executionTarget: { serverId: 'home', machineId: 'shared-machine' },
      directory: { kind: 'path', path: '/workspace' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    }, uncertain: false },
    { actionId: 'workflow.run.start' as const, input: {
      runId: '11111111-1111-4111-8111-111111111111',
      source: { kind: 'inline', definition: { version: 1, blocks: ['Work'] } },
    }, uncertain: false },
    { actionId: 'plugins.install' as const, input: {
      path: '/workspace/plugin', machineId: 'shared-machine', dev: true,
    }, uncertain: false },
    { actionId: 'plugins.enable' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'plugins.disable' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'plugins.uninstall' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'plugins.rollback' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'plugins.trust.forget' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine' }, uncertain: false },
    { actionId: 'plugins.update_policy.set' as const, input: { pluginId: 'acme.lifecycle', machineId: 'shared-machine', policy: 'pinned' }, uncertain: false },
    { actionId: 'ui.find' as const, input: { op: 'read' }, uncertain: false },
    { actionId: 'session.pending.next' as const, input: {}, uncertain: false },
    { actionId: 'workspace.tabs.list' as const, input: {}, uncertain: false },
  ])('routes $actionId with only the host admission witness and its Session capability (uncertain: $uncertain)', async ({ actionId, input, uncertain }) => {
    const command = 'node /runtime/.runner-snapshots/session-account/dist/index.mjs';
    const runner = { pid: process.pid, processStartTimeMs: 23_346,
      processCommandHash: hashProcessCommand(command), snapshotIdentity: 'snapshot:session-account' };
    processIdentity.mockResolvedValue({ pid: process.pid, processStartTimeMs: runner.processStartTimeMs, command });
    const path = await createAgentRuntimeDaemonServiceAuthorityPath(configuration);
    const authority = { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
      path, sessionId: 'caller-session', runner,
      retainedAgent: createAgentSessionRunnerFactoryBinding({
        v: 1, pluginId: 'acme.plugin', pluginVersion: '1.2.3', agentId: 'acme-agent', localAgentId: 'acme-agent',
        sourceCustody: { kind: 'managed', immutableGenerationId: `sha256:${'1'.repeat(64)}`, installSource: 'localPath' },
        locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/acme/runtime.mjs', loadMode: 'immutable-js',
      }),
    };
    await publishAgentRuntimeDaemonServiceAuthority({ ...authority, httpPort: 31_001, capability: 'A'.repeat(43) });
    vi.stubEnv('HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE', path);
    const witness = { turnId: 'host-turn', inputId: 'host-input', userMessageSeq: 1, userMessageSeqs: [1],
      agentStartCaller: { kind: 'session' as const, sessionId: 'caller-session', starterDepth: 2, turnDepth: 6 },
      callerPermissionMode: 'yolo' as const,
      causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } };
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body));
      requests.push(body);
      if (uncertain) return new Response(JSON.stringify({ ok: false, error: {
        code: NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE, message: 'Connection lost after dispatch',
      } }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, result: { kind: 'action.execution', requestId: 'request-1',
        outcome: { ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } } } }), { status: 200 });
    });
    try {
      const executor = createSessionAccountActionExecutor({ base: createRestrictedExecutor(), client: {
        sessionId: 'caller-session', getServerBinding: () => ({ serverId: 'home', serverUrl: 'https://home.test' }),
        rpcHandlerManager: { invokeLocal: async () => null, registerHandler() {} }, updateMetadata() {},
        getCurrentSessionLocation: () => ({ machineId: 'shared-machine', path: '/run/workspace' }),
        getActiveTurnAdmissionWitness: () => witness,
        ...(actionId === 'session.list' ? { getSessionActionConfirmationBinding: () => ({ turnId: witness.turnId,
          lifetimeSignal: new AbortController().signal, isCurrent: () => true,
          run: { runId: 'child-run', occurrenceId: 'child-occurrence', sidechainId: 'child-sidechain' } }) } : {}),
      } });
      await expect(executor.execute(actionId, input, {
        surface: 'cli', defaultSessionId: 'forged-session', actionRequestId: 'request-1',
        approvalOrigin: { kind: 'transcript_tool_call', sessionId: 'forged-session', toolCallId: 'tool-1', toolName: 'action_execute' },
      })).resolves.toEqual(uncertain
        ? { ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' }
        : { ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
      expect(requests[0]).toEqual({ v: 1, context: { token: 'A'.repeat(43), sessionId: 'caller-session' },
        operation: { kind: 'action.execute', surface: 'agent', requestId: 'request-1', actionId,
          ...(actionId.startsWith('scm.') ? { scmWorkspace: { machineId: 'shared-machine', directory: '/run/workspace' } } : {}),
          ...(actionId === 'session.list' ? { executionRun: { runId: 'child-run', occurrenceId: 'child-occurrence' } } : {}),
          input, witness: { ...witness, workDepth: 6 }, toolCallId: 'tool-1' } });
      expect(requests).toHaveLength(1);
    } finally { await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ ...authority, capabilityDigest: hashPrivateBearer('A'.repeat(43)) }); }
  });
});
