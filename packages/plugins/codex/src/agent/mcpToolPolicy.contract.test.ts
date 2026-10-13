import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll } from 'vitest';
import type { AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { createAgentLaunchObserver, type AgentLaunchObserverBoundaries } from '@happier-dev/plugin-sdk/testing';
import { runAgentMcpToolPolicyContract, type AgentMcpToolPolicyInvocation } from '../../../../plugin-sdk/src/testing/mcpToolPolicyContract.js';
import { createMcpToolPolicyFixture } from '@/agent/permissions/testkit/mcpToolPolicyFixture';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { withCodexNativeAttachFixture } from './runtime/appServer/runtime.nativeAttach.test-support.js';
import { startCodexAppServerRuntime } from './runtime/appServer/runtime.js';
import { createCodexNativeAppServerSessionRuntime } from './runtime/appServer/native.js';
import { assignInjectedServerKeys } from './runtime/appServer/config/overrides.js';
import { openRealCodexMcpSession } from './mcpToolPolicy.realVendor.test-support.js';

const home = mkdtempSync(join(tmpdir(), 'happier-codex-mcp-native-home-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const observer = createAgentLaunchObserver({ home });
const boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
const fixture = createMcpToolPolicyFixture(PLUGIN_MANIFEST.id, 'codex');
const pending = new Map<string, { resolve(value: AgentMcpToolPolicyInvocation): void; reject(error: unknown): void }>();
let invocationId = 0;
const realVendor = process.env.HAPPIER_MCP_REAL_VENDOR === '1';

// Native Codex is the external boundary here: the fixture produces actual
// app-server frames after an actual Session send, then calls the real MCP client
// only after the host response. This characterizes wiring, never vendor support.
async function openSession(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
  if (realVendor) { boundaries.reset(); return await openRealCodexMcpSession(request, { home,
    observer: boundaries, interactions: fixture.services.interactions }); }
  let ready!: (runtime: AgentSessionRuntime) => void;
  let failed!: (error: unknown) => void;
  const opened = new Promise<AgentSessionRuntime>((resolve, reject) => { ready = resolve; failed = reject; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  boundaries.reset();
  const done = withCodexNativeAttachFixture(async ({ runtime }) => {
    await startCodexAppServerRuntime(runtime);
    const session = createCodexNativeAppServerSessionRuntime(runtime, request.sessionId, undefined, undefined, request.mcpToolPolicy);
    session.watch(boundaries.recordRuntimeEvent);
    ready({ ...session, async dispose() { try { await session.dispose(); } finally { release(); await done; } } });
    await released;
  }, {
    directory: request.cwd, mcpServers: request.mcpServers, mcpToolPolicy: request.mcpToolPolicy,
    permissionMode: request.configuration?.permissionIntent.value ?? 'default',
    processEnv: { CODEX_HOME: home }, observer: boundaries, interactions: fixture.services.interactions,
    turnIdForStart: occurrence => `fixture-turn-${occurrence}`,
    async onTurnStart({ socket, params, turnId }) {
      const input = Array.isArray(params.input) ? params.input : [];
      const text = input.find(value => value && typeof value === 'object' && 'type' in value && value.type === 'text');
      if (!text || typeof text !== 'object' || !('text' in text) || typeof text.text !== 'string') throw new Error('Native fixture received no tool instruction');
      const call = JSON.parse(text.text) as { id: string; server: string; tool: string; arguments: Record<string, unknown> };
      const outcome = pending.get(call.id);
      if (!outcome) throw new Error('Native fixture invocation is missing');
      const key = assignInjectedServerKeys(Object.keys(request.mcpServers ?? {})).get(call.server);
      const launch = observer.observeLaunch().argv;
      const prefix = `mcp_servers.${key}.`;
      const hidden = launch.find(value => value.startsWith(`${prefix}disabled_tools=`));
      const disabled: unknown = hidden ? JSON.parse(hidden.slice(`${prefix}disabled_tools=`.length)) : [];
      if (!key || !launch.some(value => value.startsWith(`${prefix}command=`)) || (Array.isArray(disabled) && disabled.includes(call.tool))) {
        outcome.resolve({ outcome: 'hidden', permissions: [] });
        socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'fresh-thread', turn: { id: turnId, status: 'completed' } } }));
        return;
      }
      const nativeId = `native-approval-${call.id}`;
      const reply = (bytes: { toString(): string }) => {
        const result = JSON.parse(bytes.toString()) as { id?: string; result?: { answers?: Record<string, { answers: string[] }> } };
        if (result.id !== nativeId) return;
        socket.off('message', reply);
        void (async () => {
          const answer = result.result?.answers?.mcp_tool_call_approval_1?.answers[0];
          if (answer === 'Approve this Session') throw new Error('Native Session grant bypasses later host MCP policy');
          const approved = answer === 'Approve Once';
          if (approved) await fixture.callServer(call.server, call.tool, call.arguments);
          outcome.resolve({ outcome: approved ? 'completed' : 'denied', permissions: fixture.permissions() });
          socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'fresh-thread', turn: { id: turnId, status: 'completed' } } }));
        })().catch(outcome.reject);
      };
      socket.on('message', reply);
      socket.send(JSON.stringify({ method: 'item/started', params: { threadId: 'fresh-thread', turnId,
        item: { id: call.id, type: 'mcpToolCall', server: key, tool: call.tool, arguments: call.arguments } } }));
      socket.send(JSON.stringify({ id: nativeId, method: 'item/tool/requestUserInput', params: {
        threadId: 'fresh-thread', turnId, itemId: call.id,
        questions: [{ id: 'mcp_tool_call_approval_1', header: 'Tool permission', question: 'May the fixture tool run?',
          options: [{ label: 'Approve Once' }, { label: 'Approve this Session' }, { label: 'Deny' }] }],
      } }));
    },
  });
  void done.catch(failed);
  return await opened;
}

const agent = PLUGIN_MANIFEST.contributes.agents.find(candidate => candidate.id === 'codex')!;
runAgentMcpToolPolicyContract({
  agent, candidateControl: { off: 'blocked', approval: 'host' }, openSession,
  observeLaunch: observer.observeLaunch, fixtureServer: fixture.fixtureServer,
  async invokeTool(runtime, request) {
    fixture.beginInvocation(request.approvalScope);
    const id = `invoke-${++invocationId}`;
    const result = new Promise<AgentMcpToolPolicyInvocation>((resolve, reject) => pending.set(id, { resolve, reject }));
    let completed!: () => void;
    const terminal = new Promise<void>(resolve => { completed = resolve; });
    const subscription = runtime.watch(event => {
      if ((event.kind === 'turn-complete' || event.kind === 'turn-failed' || event.kind === 'turn-cancelled') && event.turnId === id) completed();
    });
    try {
      const sent = await runtime.send({ inputIds: [id], input: { text: JSON.stringify({ ...request, id }) },
        delivery: { kind: 'newTurn', turnId: id } });
      if (sent.status !== 'admitted') throw new Error(`Native fixture input ${sent.status}`);
      const invocation = realVendor ? (await terminal, { outcome: fixture.permissions().some(permission => permission.decision === 'approved')
        ? 'completed' as const : fixture.permissions().length > 0 ? 'denied' as const : 'hidden' as const,
        permissions: fixture.permissions() }) : await result;
      await terminal;
      return invocation;
    } finally { pending.delete(id); subscription.dispose(); }
  },
  async observeToolShell(runtime) {
    if (realVendor) {
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
        if (output === undefined || isError) throw new Error('The installed Codex tool shell was not observed successfully');
        return { argv: observer.observeLaunch().argv, env: { nativeToolOutput: JSON.stringify(output) } };
      } finally { subscription.dispose(); }
    }
    const env = observer.observeLaunch().env;
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env });
    return { argv: [process.execPath], env: JSON.parse(stdout) as Record<string, string> };
  },
});
