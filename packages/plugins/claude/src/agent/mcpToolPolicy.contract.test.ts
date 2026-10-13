import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { AgentSessionMcpLaunchConfig, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentLaunchObserver, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';
import { runAgentMcpToolPolicyContract, type AgentMcpToolPolicyInvocation } from '../../../../plugin-sdk/src/testing/mcpToolPolicyContract.js';
import { createMcpToolPolicyFixture } from '@/agent/permissions/testkit/mcpToolPolicyFixture';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { createClaudeAgentRuntime } from './runtime/nativeRuntime.js';
import type { PermissionHookResponse } from './hooks/protocol.js';
import { createEventsFixture, createPluginContextFixture, createSessionHooksFixture, createTerminalHostFixture } from './runtime/engine.testkit.js';
import { createClaudeMcpRealVendorBoundary } from './mcpToolPolicy.realVendor.test-support.js';

const home = mkdtempSync(join(tmpdir(), 'happier-claude-mcp-native-home-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const observer = createAgentLaunchObserver({ home });
const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
const fixture = createMcpToolPolicyFixture(PLUGIN_MANIFEST.id, 'claude');
const pending = new Map<string, { resolve(value: AgentMcpToolPolicyInvocation): void; reject(error: unknown): void }>();
let invocationId = 0;
let nativeConfigFiles: string[] = [];
const realVendor = process.env.HAPPIER_MCP_REAL_VENDOR === '1';
const realVendorBoundaries = new WeakMap<AgentSessionRuntime, Awaited<ReturnType<typeof createClaudeMcpRealVendorBoundary>>>();

async function openSession(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
  boundaries.reset(); nativeConfigFiles = [];
  const terminal = createTerminalHostFixture();
  const hooks = createSessionHooksFixture();
  const host = createPluginContextFixture(terminal.service, createEventsFixture().service, { sessionHooks: hooks.service });
  const exited = { termination: { observed: { kind: 'exit' as const, exitCode: 0 }, requestedBy: { kind: 'none' as const } },
    stdout: new Uint8Array(), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
  // Claude Code is the external boundary. It consumes actual launch settings,
  // receives the real Session input, and emits native protocol tool checks.
  // The host handler, callback codec and actual MCP bridge/server remain real.
  const exec = {
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool' as const, id: 'claude-cli' }, executablePath: '/fixture/claude' }) },
    run: async () => exited,
    clients: {
      async spawn(spec: Readonly<{ launch: Readonly<{ args?: readonly string[]; env?: Readonly<Record<string, string>> }> }>) {
        const argv = spec.launch.args ?? [];
        boundaries.recordLaunch({ argv, env: spec.launch.env });
        const configPath = argv[argv.indexOf('--mcp-config') + 1];
        if (configPath) nativeConfigFiles.push(configPath);
        const config = configPath ? JSON.parse(await readFile(configPath, 'utf8')) as { mcpServers: Record<string, AgentSessionMcpLaunchConfig> } : { mcpServers: {} };
        const settings = JSON.parse(argv[argv.indexOf('--settings') + 1] ?? '{}') as { permissions?: { deny?: string[]; ask?: string[] } };
        const listeners = new Set<(record: unknown) => void>();
        let finish!: (value: typeof exited) => void;
        const done = new Promise<typeof exited>(resolve => { finish = resolve; });
        const emit = (record: unknown) => { for (const listener of listeners) listener(record); };
        const calls = new Map<string, { id: string; server: string; tool: string; arguments: Record<string, unknown> }>();
        const complete = (call: { id: string }, result: AgentMcpToolPolicyInvocation) => {
          emit({ type: 'result', subtype: 'success', result: 'Fixture done', session_id: 'fixture-claude', is_error: false,
            num_turns: 1, total_cost_usd: 0, duration_ms: 0, duration_api_ms: 0 });
          pending.get(call.id)?.resolve(result);
        };
        return {
          wait: () => done,
          client: {
            subscribe(listener: (record: unknown) => void) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
            async write(raw: unknown) {
              if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
              if (raw.type === 'control_request' && 'request_id' in raw) {
                queueMicrotask(() => emit({ type: 'control_response', response: { subtype: 'success', request_id: raw.request_id, response: {} } }));
              } else if (raw.type === 'user' && 'message' in raw && raw.message && typeof raw.message === 'object' && 'content' in raw.message) {
                const content = raw.message.content;
                const text = typeof content === 'string' ? content : Array.isArray(content)
                  ? content.find(item => item && typeof item === 'object' && 'text' in item)?.text : undefined;
                if (typeof text !== 'string') throw new Error('Native fixture received no tool instruction');
                const call = JSON.parse(text) as { id: string; server: string; tool: string; arguments: Record<string, unknown> };
                const name = `mcp__${call.server}__${call.tool}`;
                const denied = settings.permissions?.deny?.some(rule => rule === name || rule === `mcp__${call.server}__*`);
                if (!config.mcpServers[call.server] || denied) {
                  queueMicrotask(() => complete(call, { outcome: 'hidden', permissions: [] }));
                  return;
                }
                // An omitted Ask projection under bypass is a real mis-wire:
                // the vendor would execute without entering the host callback.
                const asks = settings.permissions?.ask?.some(rule => rule === name || rule === `mcp__${call.server}__*`);
                if (!asks && argv[argv.indexOf('--permission-mode') + 1] === 'bypassPermissions') {
                  await fixture.callServer(call.server, call.tool, call.arguments, config.mcpServers[call.server]);
                  complete(call, { outcome: 'completed', permissions: [] });
                  return;
                }
                if (argv.includes('--plugin-dir')) {
                  // Ordinary Sessions install PermissionRequest instead of SDK
                  // can_use_tool. Observe the actual host hook registration.
                  const registration = hooks.service.startServer.mock.calls.at(-1)?.[0];
                  const plugin = hooks.service.createPluginDir.mock.calls.at(-1)?.[0];
                  const installed = plugin?.files?.find((file: { path: string }) => file.path === 'hooks/hooks.json')?.json;
                  if (typeof registration?.onPermissionHook !== 'function'
                    || !installed?.hooks?.PermissionRequest?.some((entry: { matcher: string }) => entry.matcher === '*' || entry.matcher === name)) {
                    throw new Error('Native Session launch did not install its permission hook');
                  }
                  try {
                    const reply: PermissionHookResponse = await registration.onPermissionHook({
                      hook_event_name: 'PermissionRequest', session_id: 'fixture-claude', cwd: request.cwd,
                      tool_name: name, tool_input: call.arguments, tool_use_id: call.id,
                    });
                    const decision = reply.hookSpecificOutput?.decision;
                    if (decision?.updatedPermissions !== undefined) throw new Error('Native MCP hook amendment bypasses future host policy');
                    const approved = decision?.behavior === 'allow';
                    if (approved) await fixture.callServer(call.server, call.tool, call.arguments, config.mcpServers[call.server]);
                    complete(call, { outcome: approved ? 'completed' : 'denied', permissions: fixture.permissions() });
                  } catch (error) { pending.get(call.id)?.reject(error); }
                  return;
                }
                calls.set(call.id, call);
                queueMicrotask(() => emit({ type: 'control_request', request_id: call.id,
                  request: { subtype: 'can_use_tool', tool_name: name, input: call.arguments } }));
              } else if (raw.type === 'control_response' && 'response' in raw && raw.response && typeof raw.response === 'object'
                && 'request_id' in raw.response && typeof raw.response.request_id === 'string') {
                const call = calls.get(raw.response.request_id);
                if (!call) return;
                calls.delete(call.id);
                const result = 'response' in raw.response && raw.response.response && typeof raw.response.response === 'object'
                  ? raw.response.response : {};
                if ('updatedPermissions' in result) throw new Error('Native MCP permission amendment bypasses future host policy');
                const approved = 'behavior' in result && result.behavior === 'allow';
                try {
                  if (!approved && fixture.permissions().length === 0) {
                    throw new Error(`Native permission failed before the actual host Handler: ${JSON.stringify(raw.response)}`);
                  }
                  if (approved) await fixture.callServer(call.server, call.tool, call.arguments, config.mcpServers[call.server]);
                  complete(call, { outcome: approved ? 'completed' : 'denied', permissions: fixture.permissions() });
                } catch (error) { pending.get(call.id)?.reject(error); }
              }
            },
          },
          process: { write: async () => undefined, dispose: async () => { finish(exited); } },
          dispose: async () => { finish(exited); },
        };
      },
    },
  } as unknown as ExecService; // Native process/JSON-stream is the external system boundary.
  const vendor = realVendor ? await createClaudeMcpRealVendorBoundary({ home, cwd: request.cwd,
    sessionId: request.sessionId, observer: boundaries, recordConfig: path => nativeConfigFiles.push(path) }) : null;
  const context = {
    services: { logger: host.logger, settings: host.settings, storage: host.storage, exec: vendor?.exec ?? exec, interactions: fixture.services.interactions },
    signal: new AbortController().signal,
    session: { id: request.sessionId, services: {
      features: host.features, terminalHost: terminal.service, sessionHooks: vendor?.sessionHooks ?? hooks.service,
      transcripts: host.agentRuntime.transcripts, accountUsage: host.agentRuntime.accountUsage,
      toolExecution: fixture.toolExecution,
      workflowActivity: host.sessions.current.workflowActivity,
      activeInput: { bind: () => ({ dispose() {} }), publishStatus: async () => undefined }, models: { bind: () => ({ dispose() {} }) },
    } }, workState: { publisher: () => ({ publish: async () => undefined }) },
  } as unknown as AgentSessionRuntimeContext; // Host services are genuine external boundaries.
  const runtime = await createClaudeAgentRuntime({ plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: 'claude' }, signal: context.signal });
  if (!runtime.sessions) throw new Error('Claude native Session owner unavailable');
  let session: AgentSessionRuntime;
  try { session = await runtime.sessions.open({ ...request, launchEnvironment: { values: { CLAUDE_CONFIG_DIR: home }, unset: [] } }, context); }
  catch (error) { await vendor?.dispose(); throw error; }
  session.watch(boundaries.recordRuntimeEvent);
  if (!vendor) return session;
  const wrapped = { ...session, async dispose() { try { await session.dispose(); } finally { await vendor.dispose(); } } };
  realVendorBoundaries.set(wrapped, vendor);
  return wrapped;
}

runAgentMcpToolPolicyContract({
  agent: PLUGIN_MANIFEST.contributes.agents.find(agent => agent.id === 'claude')!,
  candidateControl: { off: 'blocked', approval: 'host' }, openSession, fixtureServer: fixture.fixtureServer,
  observeLaunch: observer.observeLaunch, nativeConfigFiles: () => nativeConfigFiles,
  async invokeTool(runtime, request) {
    fixture.beginInvocation(request.approvalScope);
    const id = `invoke-${++invocationId}`;
    const beforeCalls = fixture.fixtureServer.observeCalls().length;
    const result = new Promise<AgentMcpToolPolicyInvocation>((resolve, reject) => pending.set(id, { resolve, reject }));
    let completed!: () => void;
    const terminal = new Promise<void>(resolve => { completed = resolve; });
    const subscription = runtime.watch(event => {
      if ((event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled') && event.turnId === id) completed();
    });
    try {
      const sent = await runtime.send({ inputIds: [id], input: { text: JSON.stringify({ ...request, id }) }, delivery: { kind: 'newTurn', turnId: id } });
      if (sent.status !== 'admitted') throw new Error(`Native fixture input ${sent.status}`);
      const invocation = realVendor ? (await terminal, {
        outcome: fixture.fixtureServer.observeCalls().length > beforeCalls && fixture.permissions().some(permission => permission.decision === 'approved')
          ? 'completed' as const : fixture.permissions().length > 0 ? 'denied' as const : 'hidden' as const,
        permissions: fixture.permissions(),
      }) : await result;
      await terminal;
      return invocation;
    } finally { pending.delete(id); subscription.dispose(); }
  },
  async observeToolShell(runtime) {
    if (realVendor) {
      const configured = await runtime.updateConfiguration?.({ mode: { value: null, updatedAtMs: 0 },
        model: { value: null, updatedAtMs: 0 }, permissionIntent: { value: 'default', updatedAtMs: 1 }, options: {} });
      if (configured?.status !== 'applied') throw new Error('The installed Claude shell fixture requires ordinary native approvals');
      const id = `shell-${++invocationId}`;
      let output: unknown;
      let isError = false;
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const subscription = runtime.watch(event => {
        if (event.kind === 'tool-result') { output = event.output; isError = event.isError === true; }
        if ((event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled') && event.turnId === id) finish();
      });
      try {
        const sent = await runtime.send({ inputIds: [id], input: { text: JSON.stringify({ server: '__tool_shell', tool: 'env', arguments: {} }) },
          delivery: { kind: 'newTurn', turnId: id } });
        if (sent.status !== 'admitted') throw new Error(`Real shell input ${sent.status}`);
        await done;
        const native = realVendorBoundaries.get(runtime)?.readShellResult();
        if (native) { output = native.output; isError = native.isError; }
        if (output === undefined || isError) throw new Error(`The installed Claude tool shell was not observed successfully: ${JSON.stringify(output)}`);
        return { argv: observer.observeLaunch().argv, env: { nativeToolOutput: JSON.stringify(output) } };
      } finally { subscription.dispose(); }
    }
    const env = observer.observeLaunch().env;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env });
    return { argv: [process.execPath], env: JSON.parse(stdout) as Record<string, string> };
  },
});
