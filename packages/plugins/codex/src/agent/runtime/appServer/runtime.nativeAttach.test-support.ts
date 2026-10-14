import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { AgentExecutionRunConversationRuntimeV1, AgentExecutionRunRuntimeContextV1, AgentSessionConfigurationSnapshot, AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildCodexAppServerArgs, createCodexNativeAppServerClient } from './client.js';
import { createCodexAppServerRuntime, startCodexAppServerRuntime, type CodexAppServerRuntimeHost } from './runtime.js';
import { openCodexNativeAppServerExecutionRunConversation, openCodexNativeAppServerSession } from './native.js';
import type { CodexProviderBindingEngineConfigV1 } from '../../providerBinding/runtimeConfig.js';
import { resolveCodexTerminalPermissionPolicy } from '../terminal/permissionPolicy.js';

// The network fixture models pinned Codex 0.159.2's empty paginated rollout:
// name/set supplies metadata; a full read persists it; native resume then works.
export async function withCodexNativeAttachFixture(run: (fixture: {
  runtime: ReturnType<typeof createCodexAppServerRuntime>;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  exec: ExecService;
  endpoints: readonly string[];
  nativeLaunches: readonly (readonly string[])[];
  resume(): Promise<unknown>;
  failRead(): void;
  failResume(message: string): void;
  emitNotification(method: string, params: Record<string, unknown>): void;
  failNextRevert(outcome: 'methodNotFound' | 'applied' | 'notApplied'): void;
  openConfiguredSession(providerSessionId?: string): Promise<AgentSessionRuntime>;
  openConfiguredRun(): Promise<AgentExecutionRunConversationRuntimeV1>;
}) => Promise<void>, options: {
  longTemporaryDirectory?: boolean;
  toolRestriction?: Pick<AgentSessionConfigurationSnapshot, 'allowedTools' | 'unlistedTools'>;
  mcpServers?: AgentSessionOpenRequest['mcpServers'];
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
  permissionMode?: string;
  interactions?: CodexAppServerRuntimeHost['ui'];
  onTurnStart?: (input: Readonly<{ socket: WebSocket; params: Record<string, unknown>; turnId: string }>) => void | Promise<void>;
  turnIdForStart?: (occurrence: number) => string;
  nativeToolMode?: 'code_mode_only' | 'direct';
  initialProviderBinding?: CodexProviderBindingEngineConfigV1;
  processEnv?: Readonly<Record<string, string | undefined>>;
  skills?: AgentSessionOpenRequest['skills'];
  appServerTransport?: 'daemonProxy';
  rejectExtraRootsSet?: boolean;
  beforeExtraRootsSetResponse?: (input: Readonly<{ occurrence: number; params: Record<string, unknown> }>) => Promise<void>;
  directory?: string;
  observer?: Readonly<{
    recordAppServerRequest(method: string, params: unknown): void;
    recordLaunch(input: Readonly<{ argv: readonly string[]; env?: Readonly<Record<string, string | undefined>> }>): void;
  }>;
} = {}) {
  // Unix IPC fixtures need short paths; TMPDIR is a genuine OS/environment boundary.
  const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ca-'));
  const priorTmpdir = process.env.TMPDIR;
  const nativeTmpdir = options.longTemporaryDirectory ? join(root, 't'.repeat(100)) : root;
  await mkdir(nativeTmpdir, { recursive: true });
  process.env.TMPDIR = nativeTmpdir;
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\happier-codex-native-attach-${process.pid}-${Date.now()}`
    : join(root, 's');
  const server = createServer();
  const ws = new WebSocketServer({ server });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const endpoints: string[] = [];
  const nativeLaunches: (readonly string[])[] = [];
  let named = false;
  let materialized = false;
  let rejectRead = false;
  let resumeFailure: string | null = null;
  let extraRootsSetOccurrence = 0;
  let turnStartOccurrence = 0;
  let revertFailure: 'methodNotFound' | 'applied' | 'notApplied' | null = null;
  const nativeServers = new Set([ws]);
  const turns: Array<{ id: string; status: string }> = [];
  const emitNotification = (method: string, params: Record<string, unknown>) => {
    if (method === 'turn/completed' && params.turn && typeof params.turn === 'object') {
      const observed = params.turn as { id?: unknown; status?: unknown };
      const turn = turns.find((entry) => entry.id === observed.id);
      if (turn && typeof observed.status === 'string') turn.status = observed.status;
    }
    for (const webSockets of nativeServers) {
      for (const socket of webSockets.clients) socket.send(JSON.stringify({ method, params }));
    }
  };
  const bindServer = (webSockets: WebSocketServer) => webSockets.on('connection', (socket) => socket.on('message', async (payload) => {
    const message = JSON.parse(payload.toString()) as {
      id?: number; method: string; params?: Record<string, unknown>;
    };
    if (message.id === undefined || typeof message.method !== 'string') return;
    const params = message.params ?? {};
    requests.push({ method: message.method, params });
    options.observer?.recordAppServerRequest(message.method, params);
    if (message.method === 'skills/extraRoots/set') {
      await options.beforeExtraRootsSetResponse?.({ occurrence: ++extraRootsSetOccurrence, params });
    }
    let result: unknown = {};
    let error: unknown;
    const turnId = message.method === 'turn/start'
      ? options.turnIdForStart?.(++turnStartOccurrence) ?? `provider-turn-${turnStartOccurrence}` : 'fixture-turn';
    if (message.method === 'initialize') {
      result = { userAgent: 'happier_cli/0.162.1 (fixture)' };
    } else if (message.method === 'config/read') {
      result = { config: { mcp_servers: options.mcpServers ? { happier__wilson: { enabled: true } } : {}, features: { code_mode: { excluded_tool_namespaces: ['functions'] } } } };
    } else if (message.method === 'thread/start') {
      result = { model: 'fixture-model', thread: { id: 'fresh-thread', turns: [] }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' };
    } else if (message.method === 'turn/start') {
      const turn = { id: turnId, status: 'inProgress' };
      turns.push(turn);
      materialized = true;
      result = { turn: { ...turn, items: [] } };
    } else if (message.method === 'thread/name/set') {
      named = true;
    } else if (message.method === 'thread/read') {
      if (rejectRead) error = { code: -32000, message: 'rollout persistence failed' };
      else {
        materialized ||= named && params.includeTurns === true;
        result = { thread: { id: params.threadId, turns } };
      }
    } else if (message.method === 'thread/resume') {
      if (resumeFailure) error = { code: -32000, message: resumeFailure };
      else if (params.threadId === 'fresh-thread' && !materialized) error = { code: -32000, message: 'no rollout found' };
      else result = { thread: { id: params.threadId, turns }, sandbox: { type: 'readOnly' }, reasoningEffort: 'low' };
    } else if (message.method === 'turn/interrupt') {
      const turn = turns.find((entry) => entry.id === params.turnId);
      if (!turn) throw new Error('Cannot interrupt an unknown fixture turn');
      turn.status = 'interrupted';
    } else if (message.method === 'thread/revert') {
      if (revertFailure === 'methodNotFound') error = { code: -32601, message: 'Method not found' };
      else if (revertFailure) error = { code: -32000, message: 'Rollback reply lost' };
      if (!revertFailure || revertFailure === 'applied') {
        const index = turns.findIndex((turn) => turn.id === params.beforeTurnId);
        if (index >= 0) turns.splice(index);
      }
      revertFailure = null;
    } else if (message.method === 'thread/rollback') {
      turns.splice(-Number(params.numTurns));
    } else if (message.method === 'thread/turns/list') {
      result = { data: turns, nextCursor: null };
    } else if (message.method === 'experimentalFeature/list') {
      result = { data: [{ name: 'realtime_conversation', enabled: true }], nextCursor: null };
    } else if (message.method === 'skills/extraRoots/set' && options.rejectExtraRootsSet) {
      error = { code: -32601, message: 'Method not found' };
    }
    socket.send(JSON.stringify({ id: message.id, ...(error ? { error } : { result }) }));
    if (message.method === 'turn/start') await options.onTurnStart?.({ socket, params, turnId });
    if (message.method === 'turn/interrupt') {
      emitNotification('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } });
    }
    if (message.method === 'thread/realtime/start') {
      socket.send(JSON.stringify({ method: 'thread/realtime/started', params: { threadId: 'fresh-thread', realtimeSessionId: null, version: 'v3' } }));
      socket.send(JSON.stringify({ method: 'thread/realtime/sdp', params: { threadId: 'fresh-thread', sdp: 'answer' } }));
    }
  }));
  bindServer(ws);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  // Only tool resolution crosses the Exec boundary; the real client uses Unix transport.
  const exec = {
    systemTools: { resolve: async () => ({ executable: { kind: 'systemTool', id: 'codex-cli' }, executablePath: '/fixture/codex' }) },
    run: async () => ({ stdout: new TextEncoder().encode(JSON.stringify({ models: [{ slug: 'fixture-model', tool_mode: options.nativeToolMode === 'direct' ? undefined : 'code_mode_only' }, { slug: 'direct-model' }] })), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false, termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } }),
  } as unknown as ExecService;
  const createClient = async (request?: { toolRestrictionRequired?: boolean; toolRestrictionAllowedMcpServerKeys?: readonly string[]; configOverrides?: readonly string[]; disableUserMcpServers?: boolean; processEnv?: Readonly<Record<string, string | undefined>> }) => {
    // Observe the real config/argv owner at the process boundary; this fixture substitutes Unix transport for the process.
    options.observer?.recordLaunch({ argv: buildCodexAppServerArgs({ ...request, env: request?.processEnv ?? {} }), env: request?.processEnv });
    return await createCodexNativeAppServerClient({
      exec, processEnv: {}, toolRestrictionRequired: request?.toolRestrictionRequired, toolRestrictionAllowedMcpServerKeys: request?.toolRestrictionAllowedMcpServerKeys, transport: { kind: 'unixWebSocket', socketPath, realtimeConversationAdvertised: true },
    });
  };
  const runtime = createCodexAppServerRuntime({
    directory: options.directory ?? root, happierSessionId: 'actual-happier-session',
    toolRestriction: options.toolRestriction,
    mcpServers: options.mcpServers,
    mcpToolPolicy: options.mcpToolPolicy,
    initialPermissionMode: options.permissionMode,
    initialProviderBinding: options.initialProviderBinding,
    processEnv: options.processEnv,
    skills: options.skills,
    appServerTransport: options.appServerTransport,
    resolveCurrentPolicy: () => options.permissionMode
      ? resolveCodexTerminalPermissionPolicy(options.permissionMode)
      : ({ approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }),
    host: { baseProcessEnv: {}, logger: { debug() {}, warn() {} }, createClient, ui: options.interactions },
  });
  const opened: { session: AgentSessionRuntime | null } = { session: null };
  let openedRun: AgentExecutionRunConversationRuntimeV1 | null = null;
  await runtime.updateConfig?.({ configOption: { id: 'reasoning_effort', value: 'low' } });
  const nativeExec = {
    ...exec,
    run: async (request: { args: readonly string[] }) => ({
      stdout: new TextEncoder().encode(request.args.includes('--version') ? 'codex-cli 0.159.2' : request.args.includes('models') ? JSON.stringify({ models: [{ slug: 'fixture-model', tool_mode: options.nativeToolMode === 'direct' ? undefined : 'code_mode_only' }, { slug: 'direct-model' }] }) : ''),
      stderr: new Uint8Array(),
      stdoutTruncated: false, stderrTruncated: false,
      termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } },
    }),
    spawn: async (request: { args: readonly string[] }) => {
      nativeLaunches.push([...request.args]);
      const endpoint = request.args[request.args.indexOf('--listen') + 1];
      if (!endpoint?.startsWith('unix://')) throw new Error('Expected shared native socket launch');
      endpoints.push(endpoint);
      const nativeSocketPath = endpoint.slice('unix://'.length);
      // Codex rejects overlong AF_UNIX paths. Node may silently truncate them;
      // model the native process's platform rejection instead of hanging in stat.
      if (Buffer.byteLength(nativeSocketPath) > (process.platform === 'darwin' ? 103 : 107)) {
        throw Object.assign(new Error('Native socket path is too long'), { code: 'ENAMETOOLONG' });
      }
      await mkdir(dirname(nativeSocketPath), { recursive: true, mode: 0o700 });
      const nativeServer = createServer();
      const nativeWebSockets = new WebSocketServer({ server: nativeServer });
      nativeServers.add(nativeWebSockets);
      bindServer(nativeWebSockets);
      await new Promise<void>((resolve, reject) => {
        nativeServer.once('error', reject);
        nativeServer.listen(nativeSocketPath, resolve);
      });
      let settleExit!: (value: unknown) => void;
      const exited = new Promise((resolve) => { settleExit = resolve; });
      return {
        wait: () => exited,
        dispose: async () => {
          for (const socket of nativeWebSockets.clients) socket.terminate();
          await new Promise<void>((resolve) => nativeWebSockets.close(() => resolve()));
          await new Promise<void>((resolve, reject) => nativeServer.close((error) => error ? reject(error) : resolve()));
          settleExit({ termination: { observed: { kind: 'exit', exitCode: 0 } } });
          nativeServers.delete(nativeWebSockets);
        },
      };
    },
  } as unknown as ExecService;
  try {
    await run({ runtime, requests, exec: nativeExec, endpoints, nativeLaunches, emitNotification,
      failNextRevert: (outcome) => { revertFailure = outcome; },
      failRead: () => { rejectRead = true; }, failResume: (message) => { resumeFailure = message; }, async openConfiguredSession(providerSessionId) {
      // Exec and host SDK services are genuine external boundaries; native/runtime/client logic stays real.
      const context = {
        signal: new AbortController().signal,
        services: { exec: nativeExec, logger: { debug() {}, warn() {} }, sessions: {} },
        session: { id: 'actual-happier-session', services: {} },
        ui: { title: { set: async () => undefined } },
      } as unknown as AgentSessionRuntimeContext;
      opened.session = await openCodexNativeAppServerSession({
        ...(providerSessionId ? { kind: 'resume' as const, providerSessionId } : { kind: 'create' as const }),
        sessionId: 'actual-happier-session', cwd: root,
        launchEnvironment: { values: { CODEX_HOME: root }, unset: ['CODEX_SQLITE_HOME', 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON'] },
        configuration: {
          mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 1 },
          permissionIntent: { value: 'read-only', updatedAtMs: 1 },
          options: { reasoning_effort: { value: 'low', updatedAtMs: 1 } },
          ...options.toolRestriction,
        },
        ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options.skills ? { skills: options.skills } : {}),
        startupInstructions: { v: 1, id: 'fixture.startup', revision: 1, instructions: 'Actual startup instructions.' },
      }, context);
      return opened.session;
    }, async openConfiguredRun() {
      const context = {
        signal: new AbortController().signal,
        services: { exec: nativeExec, logger: { debug() {}, warn() {} } },
        executionRun: { id: 'skills-run-1', services: {} },
      } as unknown as AgentExecutionRunRuntimeContextV1;
      openedRun = await openCodexNativeAppServerExecutionRunConversation({
        kind: 'create', runId: 'skills-run-1', cwd: root,
        profile: { pluginId: 'happier.agent.codex', localId: 'codex' },
        input: { text: 'Use the review skill.' },
        launchEnvironment: { values: { CODEX_HOME: root }, unset: ['CODEX_SQLITE_HOME', 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON'] },
        configuration: {
          mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 1 },
          permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {},
        },
        ...(options.skills ? { skills: options.skills } : {}),
      }, context);
      return openedRun;
    }, async resume() {
      const peer = await createClient();
      try { return await peer.request('thread/resume', { threadId: 'fresh-thread' }); }
      finally { await peer.dispose(); }
    } });
  } finally {
    await openedRun?.dispose();
    await opened.session?.dispose();
    await runtime.dispose();
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    if (priorTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = priorTmpdir;
  }
}
