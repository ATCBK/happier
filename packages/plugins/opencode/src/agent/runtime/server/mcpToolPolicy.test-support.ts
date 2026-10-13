import { createServer, type ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ManagedServiceHandle, ManagedServiceSnapshot } from '@happier-dev/plugin-sdk/managed-services';
import { createAgentLaunchObserver, type AgentLaunchObserverBoundaries } from '../../../../../../plugin-sdk/src/testing/observeAgentLaunch.js';
import type { AgentMcpToolPolicyContractInput, AgentMcpToolPolicyInvocation } from '@happier-dev/plugin-sdk/testing';
import { createMcpToolPolicyFixture } from '@/agent/permissions/testkit/mcpToolPolicyFixture';
import { createOpenCodeAgentRuntime } from '../nativeRuntime.js';
import { buildOpenCodeSessionMcpProjection, sanitizeOpenCodeMcpName } from './mcpRegistration.js';
import { PLUGIN_MANIFEST } from '../../../manifest.js';
import { buildOpenCodeManagedLaunchEnvironment } from './spawnSpec.js';
import type { AcpMcpPolicyVendorBoundary } from '@/agent/acp/testkit/mcpToolPolicyHarness';

export function createOpenCodeMcpToolPolicyFixture(onTrace: (message: string) => void = () => undefined, vendor?: AcpMcpPolicyVendorBoundary): AgentMcpToolPolicyContractInput {
let observer: ReturnType<typeof createAgentLaunchObserver>;
let boundaries: AgentLaunchObserverBoundaries;
const fixture = createMcpToolPolicyFixture(PLUGIN_MANIFEST.id, 'opencode');
const pending = new Map<string, { resolve(value: AgentMcpToolPolicyInvocation): void; reject(error: unknown): void }>();
let invocationNumber = 0;
let vendorEnvironment: Readonly<Record<string, string>> = {};
let nativeHome = '';

type NativeCall = { id: string; server: string; tool: string; arguments: Record<string, unknown> };
type NativeRule = { permission: string; pattern: string; action: 'ask' | 'deny' | 'allow' };

// The vendor HTTP/SSE process is the boundary fixture. Prompts reach the actual
// OpenCode leaf; its emitted native rules and permission replies govern a real
// MCP client and fixture server. This proves source wiring, not vendor support.
async function openSession(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
  if (vendor) return openVendorSession(request);
  boundaries.reset();
  const controller = new AbortController();
  const events = new Set<ServerResponse>();
  const history: unknown[] = [];
  const nativeCalls = new Map<string, NativeCall>();
  let nativeRules: NativeRule[] = [];
  let providerSessionId = 'fixture-opencode';
  let currentStatus: 'busy' | 'idle' = 'idle';
  const mcpServers = { ...request.mcpServers, happier: Object.values(request.mcpServers ?? {})[0]! };
  const projection = buildOpenCodeSessionMcpProjection(request.sessionId, mcpServers);
  const emit = (type: string, properties: unknown) => {
    onTrace(`native event ${type}`);
    const bytes = `data: ${JSON.stringify({ type, properties })}\n\n`;
    for (const response of events) response.write(bytes);
  };
  const finish = (call: NativeCall, approved: boolean) => {
    history.push({ info: { id: `assistant-${call.id}`, sessionID: providerSessionId, role: 'assistant',
      parentID: `user-${call.id}`, finish: 'stop', time: { created: Date.now(), completed: Date.now() } },
      parts: [{ id: `text-${call.id}`, messageID: `assistant-${call.id}`, sessionID: providerSessionId, type: 'text', text: approved ? 'Completed' : 'Denied' }] });
    currentStatus = 'idle';
    emit('session.status', { sessionID: providerSessionId, status: { type: 'idle' } });
  };
  const server = createServer(async (incoming, response) => {
    try {
      const url = new URL(incoming.url ?? '/', 'http://fixture');
      const path = url.pathname;
      onTrace(`native request ${incoming.method} ${path}`);
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks).toString('utf8');
      const body = bytes ? JSON.parse(bytes) as Record<string, unknown> : {};
      boundaries.recordAppServerRequest(`${incoming.method} ${path}`, body);
      const json = (value: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (path === '/event') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        events.add(response); response.once('close', () => events.delete(response));
        emit('server.connected', {}); return;
      }
      if (path === '/mcp') { json({ [String(body.name)]: { status: 'connected' } }); return; }
      if (path === '/session' && incoming.method === 'POST') {
        nativeRules = body.permission as NativeRule[];
        providerSessionId = `fixture-${request.sessionId}`;
        json({ id: providerSessionId }); return;
      }
      if (path === `/session/${providerSessionId}/message` && incoming.method === 'POST') {
        const parts = body.parts as Array<{ type: string; text?: string }>;
        const text = parts.find(part => part.type === 'text')?.text;
        if (!text) throw new Error('Native fixture received no tool instruction');
        const call = JSON.parse(text) as NativeCall;
        const result = pending.get(call.id);
        if (!result) throw new Error('Native fixture invocation is missing');
        history.push({ info: { id: `user-${call.id}`, sessionID: providerSessionId, role: 'user', time: { created: Date.now() } }, parts });
        currentStatus = 'busy';
        json({ id: `user-${call.id}` });
        const registration = projection.registrations.find(entry => entry.originalName === call.server);
        if (!registration) { result.resolve({ outcome: 'hidden', permissions: [] }); finish(call, false); return; }
        const tool = `${registration.projectedName}_${sanitizeOpenCodeMcpName(call.tool)}`;
        const rule = nativeRules.filter(rule => rule.permission === '*' || rule.permission === tool
          || (rule.permission.endsWith('*') && tool.startsWith(rule.permission.slice(0, -1)))).at(-1);
        if (rule?.action === 'deny') { result.resolve({ outcome: 'denied', permissions: [] }); finish(call, false); return; }
        if (rule?.action === 'allow') throw new Error('Native MCP Allow bypasses live host policy');
        nativeCalls.set(call.id, call);
        emit('permission.asked', { id: call.id, sessionID: providerSessionId, permission: tool, patterns: ['*'] });
        return;
      }
      if (path.startsWith('/permission/') && path.endsWith('/reply')) {
        const id = decodeURIComponent(path.split('/')[2]!);
        const call = nativeCalls.get(id);
        const result = pending.get(id);
        if (!call || !result) throw new Error('Native permission reply has no invocation');
        if (body.reply === 'always') throw new Error('Native MCP Session grant bypasses later live policy');
        const approved = body.reply === 'once';
        if (approved) await fixture.callServer(call.server, call.tool, call.arguments);
        result.resolve({ outcome: approved ? 'completed' : 'denied', permissions: fixture.permissions() });
        nativeCalls.delete(id); json({}); finish(call, approved); return;
      }
      if (path === `/session/${providerSessionId}/message`) { json(history); return; }
      if (path === '/session/status') { json({ [providerSessionId]: { type: currentStatus } }); return; }
      if (path === '/agent' || path === '/command' || path === '/permission' || path === '/question') { json([]); return; }
      if (path === '/provider') { json({ all: [] }); return; }
      json({});
    } catch (error) {
      for (const result of pending.values()) result.reject(error);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Native fixture listener unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  const snapshot = (): ManagedServiceSnapshot => ({ id: 'opencode-server', state: 'healthy', mode: 'spawn', baseUrl: origin,
    startedAtMs: 1, lastHealthyAtMs: 1, diagnostics: [], diagnosticsTruncated: false });
  const handle: ManagedServiceHandle = {
    snapshot, observe(listener) { listener(snapshot()); return { dispose() {} }; },
    waitUntilHealthy: async () => snapshot(), stop: async () => ({ status: 'stopped' }),
    async dispose() {
      controller.abort(); for (const response of events) response.end();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    },
    async request(input) {
      const response = await fetch(`${origin}${input.pathAndQuery}`, { method: input.method, headers: input.headers,
        ...(input.body ? { body: input.body } : {}), signal: input.signal });
      return { ok: response.ok, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers), body: response.body };
    },
  };
  const storage = new Map<string, unknown>();
  const noop = (message?: string) => { if (message) onTrace(message); };
  // SDK host services are the process/storage/interaction boundaries; internal
  // native codecs, assembly and the permission Handler remain real.
  const context = { signal: controller.signal, services: {
    interactions: fixture.services.interactions, logger: { debug: noop, info: noop, warn: noop, error: noop },
    connectedAccounts: { watch(_purpose: string, listener: (event: { kind: 'resync' }) => void) { listener({ kind: 'resync' }); return { dispose() {} }; }, getBinding: async () => null },
    exec: { systemTools: { resolve: async () => ({ executablePath: '/fixture/opencode' }) } },
    managedServices: { dependencies: {}, async supervise(spec: import('@happier-dev/plugin-sdk/managed-services').ManagedServiceSpec) {
      if (spec.mode.kind !== 'spawn') throw new Error('Expected native managed launch');
      boundaries.recordLaunch({ argv: ['opencode', ...(spec.mode.launch.args ?? [])], env: spec.mode.launch.env });
      return handle;
    } },
    storage: { daemonSession: { get: async (key: string) => storage.get(key) ?? null, set: async (key: string, value: unknown) => { storage.set(key, value); } } },
  } } as unknown as AgentSessionRuntimeContext;
  try {
    const runtime = await createOpenCodeAgentRuntime({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'opencode' }, signal: controller.signal });
    const session = await runtime.sessions.open({ ...request, mcpServers }, context);
    session.watch(boundaries.recordRuntimeEvent);
    return session;
  } catch (error) { await handle.dispose(); throw error; }
}

// The installed process is the only Agent implementation on this path. Host process
// supervision and model HTTP are genuine system boundaries; the leaf remains real.
async function openVendorSession(request: AgentSessionOpenRequest): Promise<AgentSessionRuntime> {
  if (!vendor) throw new Error('Installed OpenCode executable required');
  const controller = new AbortController();
  const storage = new Map<string, unknown>();
  let owned: ManagedServiceHandle | undefined;
  const context = { signal: controller.signal, services: {
    interactions: fixture.services.interactions,
    logger: { debug: onTrace, info: onTrace, warn: onTrace, error: onTrace },
    connectedAccounts: { watch(_purpose: string, listener: (event: { kind: 'resync' }) => void) { listener({ kind: 'resync' }); return { dispose() {} }; }, getBinding: async () => null },
    exec: { systemTools: { resolve: async () => ({ executablePath: vendor.executablePath }) } },
    managedServices: { dependencies: {}, async supervise(spec: import('@happier-dev/plugin-sdk/managed-services').ManagedServiceSpec) {
      if (spec.mode.kind !== 'spawn') throw new Error('Expected real OpenCode managed spawn');
      const allocation = createServer();
      await new Promise<void>(resolve => allocation.listen(0, '127.0.0.1', resolve));
      const address = allocation.address(); if (!address || typeof address === 'string') throw new Error('Missing real OpenCode port');
      await new Promise<void>(resolve => allocation.close(() => resolve()));
      const origin = `http://127.0.0.1:${address.port}`;
      const argv = [...spec.mode.launch.args ?? [], '--port', String(address.port)];
      const env = { HOME: nativeHome, ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...spec.mode.launch.env };
      boundaries.recordLaunch({ argv: [vendor.executablePath, ...argv], env });
      const child = spawn(vendor.executablePath, argv, { cwd: request.cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', bytes => onTrace(String(bytes)));
      child.stderr.on('data', bytes => onTrace(String(bytes)));
      let failure: Error | undefined; child.on('error', error => { failure = error; });
      const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
      const snapshot = (): ManagedServiceSnapshot => ({ id: spec.id, state: 'healthy', mode: 'spawn', baseUrl: origin,
        startedAtMs: 1, lastHealthyAtMs: 1, diagnostics: [], diagnosticsTruncated: false });
      const dispose = async () => {
        controller.abort();
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === 'win32') child.kill('SIGTERM');
          else process.kill(-child.pid!, 'SIGTERM');
        }
        await exited;
      };
      owned = {
        snapshot, observe(listener) { listener(snapshot()); return { dispose() {} }; },
        async waitUntilHealthy() {
          for (;;) {
            if (failure) throw failure;
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('Installed OpenCode ended before health');
            try { const health = await fetch(`${origin}/global/health`, { signal: controller.signal }); if (health.ok) return snapshot(); } catch {}
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        },
        stop: async () => { await dispose(); return { status: 'stopped' }; }, dispose,
        async request(input) {
          boundaries.recordAppServerRequest(`${input.method} ${input.pathAndQuery}`, input.body);
          const response = await fetch(`${origin}${input.pathAndQuery}`, { method: input.method, headers: input.headers,
            ...(input.body ? { body: input.body } : {}), signal: input.signal });
          return { ok: response.ok, status: response.status, statusText: response.statusText,
            headers: Object.fromEntries(response.headers), body: response.body };
        },
      };
      return owned;
    } },
    storage: { daemonSession: { get: async (key: string) => storage.get(key) ?? null, set: async (key: string, value: unknown) => { storage.set(key, value); } } },
  } } as unknown as AgentSessionRuntimeContext;
  try {
    const runtime = await createOpenCodeAgentRuntime({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, agent: { id: 'opencode' }, signal: controller.signal });
    const session = await runtime.sessions.open({ ...request, launchEnvironment: { values: vendorEnvironment, unset: [] },
      mcpServers: { ...request.mcpServers, happier: Object.values(request.mcpServers ?? {})[0]! } }, context);
    session.watch(boundaries.recordRuntimeEvent);
    return { ...session, async dispose(reason) { try { await session.dispose(reason); } finally { await owned?.dispose(); } } };
  } catch (error) { await owned?.dispose(); throw error; }
}

const agent = PLUGIN_MANIFEST.contributes.agents.find(candidate => candidate.id === 'opencode')!;
return {
  agent, candidateControl: { off: 'blocked', approval: 'host' }, openSession,
  observeLaunch: () => observer.observeLaunch(), fixtureServer: {
    ...fixture.fixtureServer,
    async prepare(input) {
      const result = await fixture.fixtureServer.prepare(input);
      const home = join(input.cwd, 'native-home');
      await mkdir(home);
      nativeHome = home;
      vendorEnvironment = await vendor?.prepare(input) ?? {};
      observer = createAgentLaunchObserver({ home });
      boundaries = observer.boundaries as AgentLaunchObserverBoundaries;
      return result;
    },
    async dispose() { try { await fixture.fixtureServer.dispose(); } finally { await vendor?.dispose(); } },
  },
  async invokeTool(runtime, request) {
    fixture.beginInvocation(request.approvalScope);
    const id = `invoke-${++invocationNumber}`;
    const result = new Promise<AgentMcpToolPolicyInvocation>((resolve, reject) => pending.set(id, { resolve, reject }));
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const subscription = runtime.watch(event => {
      if ('turnId' in event && event.turnId === id && ['turn-complete', 'turn-failed', 'turn-cancelled'].includes(event.kind)) finish();
    });
    try {
      if (vendor) {
        const before = fixture.fixtureServer.observeCalls().length;
        const sent = await runtime.send({ inputIds: [id], input: { text: JSON.stringify({ ...request, id }) }, delivery: { kind: 'newTurn', turnId: id } });
        if (sent.status !== 'admitted') throw new Error(`Installed OpenCode input ${JSON.stringify(sent)}`);
        await completed;
        const permissions = fixture.permissions();
        const denied = permissions.some(permission => permission.decision === 'denied');
        if (!denied && fixture.fixtureServer.observeCalls().length === before) throw new Error('Installed OpenCode completed without the requested MCP receipt');
        return { outcome: denied ? 'denied' : 'completed', permissions };
      }
      const sent = await runtime.send({ inputIds: [id], input: { text: JSON.stringify({ ...request, id }) }, delivery: { kind: 'newTurn', turnId: id } });
      if (sent.status !== 'admitted') throw new Error(`Native fixture input ${sent.status}`);
      const outcome = await result;
      await completed;
      return outcome;
    } finally { pending.delete(id); subscription.dispose(); }
  },
  async observeToolShell() {
    if (vendor) throw new Error('K7 installed OpenCode requires an independently observed native Agent shell');
    const env = observer.observeLaunch().env;
    const size = (values: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Buffer.byteLength(`${key}=${value}\0`)]));
    onTrace(`tool-shell environment bytes ${JSON.stringify(size(env))}`);
    onTrace(`baseline environment bytes ${JSON.stringify(size(buildOpenCodeManagedLaunchEnvironment(undefined, 'default')))}`);
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env });
    return { argv: [process.execPath], env: JSON.parse(stdout) as Record<string, string> };
  },
};
}
