import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resolveNodeBackedMcpServerCommand } from '@/mcp/runtime/resolveNodeBackedMcpServerCommand';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { createConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH } from '@happier-dev/protocol/connect/connected-account-request-auth';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { MCP_REQUEST_AUTH_PURPOSE } from '@/mcp/runtime/mcpRequestAuth';
import { createEphemeralTlsServerFixture, type EphemeralTlsServerFixture } from '../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs';

const bridgePurpose = MCP_REQUEST_AUTH_PURPOSE;

async function startBridgeRequestAuth(root: string, resource: string) {
  let revision = 0;
  let reports = 0;
  let lookups = 0;
  let active = true;
  const scopes: string[] = [];
  const account = { service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: 'server-one' };
  const binding = { purpose: bridgePurpose, target: { kind: 'account' as const, account } };
  const use = { purpose: bridgePurpose, materialization: { kind: 'httpHeaders' as const, origin: new URL(resource).origin, headerNames: ['authorization'] } };
  const registry = createConnectedAccountRequestAuthSubjectRegistry();
  const owner = createConnectedAccountRequestAuthService({
    resolveCurrentBinding: () => ({ account, credentialRevision: `csr_${String(revision).padStart(24, '0')}` }),
    materializeBearer: async () => ({ accessToken: `bearer-${revision}` }),
    refreshAfterAuthFailure: async () => { reports++; revision++; return { status: 'current_changed' }; },
    reportQuotaFailure: async () => ({ status: 'denied' }),
    reportScopeFailure: async ({ failure }) => { scopes.push(...failure.requiredScopes); return { status: 'current_unchanged' }; },
  });
  const app = createDaemonControlApp({
    getChildren: () => [], machineId: 'test-machine',
    stopSession: async () => ({ status: 'not_found' }),
    spawnSession: async () => ({ type: 'error', errorCode: 'unexpected', errorMessage: 'unused' }),
    requestShutdown: () => undefined, onHappySessionWebhook: () => undefined,
    controlToken: 'test-control',
    connectedAccountRequestAuth: { authenticate: registry.authenticate, ...owner },
  });
  app.addHook('onRequest', async (request) => { if (request.url === CONNECTED_ACCOUNT_REQUEST_AUTH_LOOKUP_PATH) lookups++; });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('request_auth_address_unavailable');
  const descriptor = await registry.activate({
    subject: { subjectId: 'bridge-operation', parentSessionId: 'parent-session', isCurrent: () => active,
      registerRedaction: () => undefined, resolvePurposeUse: () => ({ binding, use }), listPurposeUses: () => [{ binding, use }] },
    materializedRootDir: root, materializationId: 'server-one', httpPort: address.port,
  });
  return { capabilityFile: descriptor.path, rotate: () => { revision++; },
    revoke: () => { active = false; },
    counts: () => ({ reports, lookups }), scopes,
    stop: async () => { await registry.retire(descriptor); await app.close(); } };
}

function resolveEnvRecord(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

async function resolveRemoteBridgeInvocation(): Promise<{
  command: string;
  args: string[];
  env?: Record<string, string>;
}> {
  const invocation = await resolveNodeBackedMcpServerCommand({
    distEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.mjs'],
    sourceEntrypointSegments: ['mcp', 'bridges', 'remoteMcpStdioBridge.ts'],
    preferSourceEntrypoint: true,
  });
  return { ...invocation, args: ['--conditions=happier-source', ...invocation.args] };
}

async function waitForJsonRpcResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs = 10_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSON-RPC response ${id}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line) as Readonly<{ id?: unknown }>;
          if (message.id === id) {
            cleanup();
            resolve();
            return;
          }
        } catch {
          // Keep reading until a complete JSON-RPC response arrives.
        }
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Bridge exited before JSON-RPC response ${id}: ${code ?? signal ?? 'unknown'}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 3_000,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for remote MCP bridge process to exit'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code: number | null) => {
      cleanup();
      resolve(code);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function startTestMcpHttpServer(onRequest?: (req: IncomingMessage, res: ServerResponse) => boolean, tls?: EphemeralTlsServerFixture): Promise<{ url: string; stop: () => void }> {
  const server = tls ? createSecureServer({ key: await readFile(tls.privateKeyPath), cert: await readFile(tls.leafCertificatePath) }) : createServer();
  server.on('request', async (req, res) => {
    if (onRequest && !onRequest(req, res)) return;
    const mcp = new McpServer({ name: 'test-mcp', version: '1.0.0' });
    mcp.registerTool(
      'echo',
      {
        description: 'Echo',
        inputSchema: z.object({ text: z.string() }).passthrough(),
        outputSchema: z.object({ echoed: z.string() }),
        annotations: { readOnlyHint: true },
        _meta: { 'acme.example/source': 'integration-test' },
      } as any,
      async (args: any) => ({
        content: [{ type: 'text' as const, text: String(args?.text ?? '') }],
        structuredContent: { echoed: String(args?.text ?? '') },
        isError: false as const,
      }),
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.once('close', () => {
      transport.close().catch(() => {});
      Promise.resolve(mcp.close()).catch(() => {});
    });

    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });

  const baseUrl = await new Promise<URL>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(new URL(`${tls ? 'https' : 'http'}://127.0.0.1:${addr.port}`));
    });
  });

  return { url: baseUrl.toString(), stop: () => server.close() };
}

async function startTestMcpSseServer(tls?: EphemeralTlsServerFixture, observe?: (request: IncomingMessage) => void): Promise<{ url: string; stop: () => void }> {
  const transportsBySessionId = new Map<string, { transport: SSEServerTransport; mcp: McpServer }>();

  const server = tls ? createSecureServer({ key: await readFile(tls.privateKeyPath), cert: await readFile(tls.leafCertificatePath) }) : createServer();
  server.on('request', async (req, res) => {
    observe?.(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/sse') {
      const mcp = new McpServer({ name: 'test-mcp-sse', version: '1.0.0' });
      mcp.registerTool(
        'echo',
        {
          description: 'Echo',
          inputSchema: z.object({ text: z.string() }).passthrough(),
          outputSchema: z.object({ echoed: z.string() }),
          annotations: { readOnlyHint: true },
          _meta: { 'acme.example/source': 'sse-integration-test' },
        } as any,
        async (args: any) => ({
          content: [{ type: 'text' as const, text: String(args?.text ?? '') }],
          structuredContent: { echoed: String(args?.text ?? '') },
          isError: false as const,
        }),
      );

      const transport = new SSEServerTransport('/message', res);
      transportsBySessionId.set(transport.sessionId, { transport, mcp });

      res.once('close', () => {
        transportsBySessionId.delete(transport.sessionId);
        transport.close().catch(() => {});
        Promise.resolve(mcp.close()).catch(() => {});
      });

      await mcp.connect(transport);
      return;
    }

    if (req.method === 'POST' && pathname === '/message') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const entry = transportsBySessionId.get(sessionId) ?? null;
      if (!entry) {
        res.writeHead(404).end('unknown session');
        return;
      }
      await entry.transport.handlePostMessage(req as any, res);
      return;
    }

    res.writeHead(404).end();
  });

  const baseUrl = await new Promise<URL>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(new URL(`${tls ? 'https' : 'http'}://127.0.0.1:${addr.port}`));
    });
  });

  return { url: new URL('/sse', baseUrl).toString(), stop: () => server.close() };
}

describe('remoteMcpStdioBridge', () => {
  it('refuses a different configured resource before requesting a bearer or reaching the MCP server', async () => {
    const tls = await createEphemeralTlsServerFixture();
    let remoteRequests = 0;
    const remote = await startTestMcpHttpServer(() => { remoteRequests++; return true; }, tls);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-resource-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    const invocation = await resolveRemoteBridgeInvocation();
    const configPath = join(root, 'bridge.json');
    await writeFile(configPath, JSON.stringify({ transport: 'http', url: remote.url, auth: { capabilityFile: auth.capabilityFile, resource: new URL('/different', remote.url).href } }), { mode: 0o600 });
    const client = new Client({ name: 'wrong-resource-test', version: '1' });
    try {
      await expect(client.connect(new StdioClientTransport({ ...invocation, env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }))).rejects.toThrow();
      expect(remoteRequests).toBe(0);
      expect(auth.counts().lookups).toBe(0);
    } finally { await client.close().catch(() => undefined); await auth.stop(); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup(); }
  });
  it('looks up a bearer for every HTTP request and reports only one 401 before retrying', async () => {
    const tls = await createEphemeralTlsServerFixture();
    const received: string[] = [];
    let rejectNext = false;
    let rejectAll = false;
    let redirect = false;
    const remote = await startTestMcpHttpServer((request, response) => {
      received.push(String(request.headers.authorization ?? ''));
      if (redirect) { response.writeHead(302, { Location: '/other-resource' }).end(); return false; }
      if (rejectNext || rejectAll) { rejectNext = false; response.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' }).end(); return false; }
      return true;
    }, tls);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-oauth-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    const invocation = await resolveRemoteBridgeInvocation();
    const configPath = join(root, 'bridge.json');
    await writeFile(configPath, JSON.stringify({ transport: 'http', url: remote.url, auth: { capabilityFile: auth.capabilityFile, resource: remote.url } }), { mode: 0o600 });
    const client = new Client({ name: 'oauth-bridge-test', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ ...invocation, env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }));
      received.splice(0);
      auth.rotate();
      const first = await client.callTool({ name: 'echo', arguments: { text: 'fresh' } });
      expect(first.isError).not.toBe(true);
      expect(received).toEqual(['Bearer bearer-1']);
      received.splice(0);
      rejectNext = true;
      const recovered = await client.callTool({ name: 'echo', arguments: { text: 'retry' } });
      expect(recovered.isError).not.toBe(true);
      expect(received).toEqual(['Bearer bearer-1', 'Bearer bearer-2']);
      expect(auth.counts().reports).toBe(1);
      expect(auth.counts().lookups).toBeGreaterThanOrEqual(received.length);
      received.splice(0);
      rejectAll = true;
      expect((await client.callTool({ name: 'echo', arguments: { text: 'still-invalid' } })).isError).toBe(true);
      expect(received).toEqual(['Bearer bearer-2', 'Bearer bearer-3']);
      expect(auth.counts().reports).toBe(2);
      rejectAll = false;
      received.splice(0);
      redirect = true;
      expect((await client.callTool({ name: 'echo', arguments: { text: 'redirect' } })).isError).toBe(true);
      expect(received).toEqual(['Bearer bearer-3']);
      redirect = false;
      received.splice(0);
      auth.revoke();
      expect((await client.callTool({ name: 'echo', arguments: { text: 'signed-out' } })).isError).toBe(true);
      expect(received).toEqual([]);
    } finally { await client.close().catch(() => undefined); await auth.stop(); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup(); }
  });

  it('refuses an OAuth SSE advertised POST endpoint outside its exact resource without sending a bearer there', async () => {
    const tls = await createEphemeralTlsServerFixture();
    const received: Array<{ path: string; authorization: string }> = [];
    const remote = await startTestMcpSseServer(tls, request => received.push({ path: request.url ?? '', authorization: String(request.headers.authorization ?? '') }));
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-sse-resource-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    const invocation = await resolveRemoteBridgeInvocation();
    const configPath = join(root, 'bridge.json');
    await writeFile(configPath, JSON.stringify({ transport: 'sse', url: remote.url, auth: { capabilityFile: auth.capabilityFile, resource: remote.url } }), { mode: 0o600 });
    const client = new Client({ name: 'sse-resource-test', version: '1' });
    try {
      await expect(client.connect(new StdioClientTransport({ ...invocation, env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }))).rejects.toThrow();
      expect(received).toEqual([{ path: '/sse', authorization: 'Bearer bearer-0' }]);
      expect(auth.counts().reports).toBe(0);
    } finally { await client.close().catch(() => undefined); await auth.stop(); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup(); }
  });

  it('reports a scope challenge and returns a tool error without refreshing or retrying', async () => {
    const tls = await createEphemeralTlsServerFixture();
    let challenge = false;
    let challengedRequests = 0;
    const remote = await startTestMcpHttpServer((_request, response) => {
      if (challenge) { challengedRequests++; response.writeHead(403, { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="write read"' }).end(); return false; }
      return true;
    }, tls);
    const root = await mkdtemp(join(tmpdir(), 'happier-mcp-scope-'));
    const auth = await startBridgeRequestAuth(root, remote.url);
    const invocation = await resolveRemoteBridgeInvocation();
    const configPath = join(root, 'bridge.json');
    await writeFile(configPath, JSON.stringify({ transport: 'http', url: remote.url, auth: { capabilityFile: auth.capabilityFile, resource: remote.url } }), { mode: 0o600 });
    const client = new Client({ name: 'scope-bridge-test', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ ...invocation, env: { ...resolveEnvRecord(), ...invocation.env, NODE_EXTRA_CA_CERTS: tls.caCertificatePath, HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath } }));
      challenge = true;
      const result = await client.callTool({ name: 'echo', arguments: { text: 'write' } });
      expect(result.isError).toBe(true);
      expect(auth.scopes).toEqual(['write', 'read']);
      expect(auth.counts().reports).toBe(0);
      expect(challengedRequests).toBe(1);
    } finally { challenge = false; await client.close().catch(() => undefined); await auth.stop(); remote.stop(); await rm(root, { recursive: true, force: true }); await tls.cleanup(); }
  });
  it('proxies listTools/callTool over streamable http via stdio', async () => {
    const httpServer = await startTestMcpHttpServer();
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    try {
      const configPath = join(tmp, 'happier-mcp-remote-bridge.it.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'http',
          url: httpServer.url,
          headers: { 'X-Test': randomUUID() },
        }),
        { mode: 0o600 },
      );

      const bridgeInvocation = await resolveRemoteBridgeInvocation();

      const transport = new StdioClientTransport({
        command: bridgeInvocation.command,
        args: bridgeInvocation.args,
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
      });

      const client = new Client({ name: 'bridge-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const tools = await client.listTools(undefined, { timeout: 180_000 });
      const names = (tools.tools ?? []).map((t: any) => String(t.name));
      expect(names).toContain('echo');
      expect(tools.tools.find((tool) => tool.name === 'echo')?.inputSchema).toMatchObject({
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      });
      expect(tools.tools.find((tool) => tool.name === 'echo')).toMatchObject({
        outputSchema: {
          type: 'object',
          properties: {
            echoed: { type: 'string' },
          },
          required: ['echoed'],
        },
        annotations: { readOnlyHint: true },
        _meta: { 'acme.example/source': 'integration-test' },
      });

      const res = await client.callTool(
        { name: 'echo', arguments: { text: 'hi' } },
        undefined,
        { timeout: 180_000 },
      );
      const text = String((res as any)?.content?.[0]?.text ?? '');
      expect(text).toBe('hi');
      expect(res.structuredContent).toEqual({ echoed: 'hi' });

      await client.close();

      const relaunchedTransport = new StdioClientTransport({
        command: bridgeInvocation.command,
        args: bridgeInvocation.args,
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
      });
      const relaunchedClient = new Client({ name: 'bridge-relaunch-test', version: '1.0.0' }, { capabilities: {} });
      try {
        await relaunchedClient.connect(relaunchedTransport);
        expect((await relaunchedClient.listTools(undefined, { timeout: 180_000 })).tools.map((tool) => tool.name)).toContain('echo');
      } finally {
        await relaunchedClient.close().catch(() => undefined);
      }
    } finally {
      httpServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('supports SSE transport via stdio bridge', async () => {
    const sseServer = await startTestMcpSseServer();
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    try {
      const configPath = join(tmp, 'bridge.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'sse',
          url: sseServer.url,
          headers: {},
        }),
        { mode: 0o600 },
      );

      const bridgeInvocation = await resolveRemoteBridgeInvocation();

      const transport = new StdioClientTransport({
        command: bridgeInvocation.command,
        args: bridgeInvocation.args,
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
      });

      const client = new Client({ name: 'bridge-test-sse', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);

      const tools = await client.listTools(undefined, { timeout: 180_000 });
      expect(tools.tools.find((tool) => tool.name === 'echo')).toMatchObject({
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
          },
          required: ['text'],
        },
        outputSchema: {
          type: 'object',
          properties: {
            echoed: { type: 'string' },
          },
          required: ['echoed'],
        },
        annotations: { readOnlyHint: true },
        _meta: { 'acme.example/source': 'sse-integration-test' },
      });

      const res = await client.callTool(
        { name: 'echo', arguments: { text: 'hi' } },
        undefined,
        { timeout: 180_000 },
      );
      const text = String((res as any)?.content?.[0]?.text ?? '');
      expect(text).toBe('hi');
      expect(res.structuredContent).toEqual({ echoed: 'hi' });

      await client.close();
    } finally {
      sseServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('closes the remote SSE client and exits when the controlling stdio stream ends', async () => {
    const sseServer = await startTestMcpSseServer();
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    let child: ChildProcessWithoutNullStreams | null = null;
    try {
      const configPath = join(tmp, 'happier-mcp-remote-bridge.it.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'sse',
          url: sseServer.url,
          headers: {},
        }),
        { mode: 0o600 },
      );
      const bridgeInvocation = await resolveRemoteBridgeInvocation();
      child = spawn(bridgeInvocation.command, bridgeInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'bridge-eof-test', version: '1.0.0' },
        },
      })}\n`);
      await waitForJsonRpcResponse(child, 1);

      child.stdin.end();

      await expect(waitForChildExit(child)).resolves.toBe(0);
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child).catch(() => undefined);
      }
      sseServer.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('preserves the config file when startup fails before the remote connect succeeds', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'happier-mcp-bridge-it-'));
    try {
      const configPath = join(tmp, 'happier-mcp-remote-bridge.it.json');
      await writeFile(
        configPath,
        JSON.stringify({
          transport: 'http',
          url: 'http://127.0.0.1:9',
          headers: { Authorization: 'Bearer SHOULD_NOT_PERSIST' },
        }),
        { mode: 0o600 },
      );

      const bridgeInvocation = await resolveRemoteBridgeInvocation();
      const child = spawn(bridgeInvocation.command, bridgeInvocation.args, {
        env: {
          ...resolveEnvRecord(),
          ...(bridgeInvocation.env ?? {}),
          HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE: configPath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? -1));
      });

      expect(exitCode).not.toBe(0);
      await expect(access(configPath)).resolves.toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
