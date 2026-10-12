/**
 * Remote MCP STDIO Bridge
 *
 * STDIO MCP server that proxies tools to a remote MCP server over:
 * - Streamable HTTP (`transport: http`)
 * - SSE (`transport: sse`)
 *
 * Bridge config is provided via env var `HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE`.
 *
 * SECURITY: never print secrets to stdout (stdout is reserved for MCP stdio).
 */

import { readFile } from 'node:fs/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createConnectedAccountRequestAuthClient } from '@happier-dev/plugin-sdk/connected-accounts/request-auth';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';
import { z } from 'zod';

import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { withMcpTimeout } from '@/mcp/runtime/withMcpTimeout';
import { runMcpStdioBridgeLifecycle } from '@/mcp/runtime/runMcpStdioBridgeLifecycle';
import { registerHappierBridgeTools } from './registerHappierBridgeTools';
import { MCP_REQUEST_AUTH_PURPOSE } from '@/mcp/runtime/mcpRequestAuth';

const MCP_BRIDGE_STARTUP_STEP_TIMEOUT_MS = 60_000;

const RemoteBridgeConfigSchema = z.object({
  transport: z.enum(['http', 'sse']),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional().default({}),
  auth: z.object({ capabilityFile: z.string().min(1), resource: z.string().url() }).strict().optional(),
});

type RemoteBridgeConfig = z.infer<typeof RemoteBridgeConfigSchema>;

class McpResourceMismatchError extends Error {
  readonly code = 'mcp_resource_mismatch';
  constructor() { super('mcp_resource_mismatch'); this.name = 'McpResourceMismatchError'; }
}

function writeStderr(line: string): void {
  try {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    // ignore
  }
}

async function connectRemoteClient(config: RemoteBridgeConfig): Promise<Client> {
  const client = new Client({ name: 'happier-remote-bridge', version: '1.0.0' }, { capabilities: {} });

  const url = new URL(config.url);
  const headers = { ...config.headers };
  if (config.auth && canonicalMcpOAuthResourceUrlV1(config.auth.resource) !== canonicalMcpOAuthResourceUrlV1(config.url)) throw new McpResourceMismatchError();
  const requestAuth = config.auth ? await createConnectedAccountRequestAuthClient({ capabilityFile: config.auth.capabilityFile }) : null;
  const fetchRemote: FetchLike | undefined = requestAuth && config.auth ? async (target, init) => {
    if (canonicalMcpOAuthResourceUrlV1(String(target)) !== canonicalMcpOAuthResourceUrlV1(config.auth!.resource)) throw new McpResourceMismatchError();
    const signal = init?.signal ?? undefined;
    const lookup = async () => {
      try { return await requestAuth.lookupConnectedAccountRequestAuth({ purpose: MCP_REQUEST_AUTH_PURPOSE, signal }); }
      catch (error) { if (signal?.aborted) throw error; throw new Error('Sign in to this MCP server in Happier.'); }
    };
    const send = async (lease: Awaited<ReturnType<typeof lookup>>) => {
      const requestHeaders = new Headers(init?.headers);
      for (const [name, value] of Object.entries(lease.requiredHeaders ?? {})) requestHeaders.set(name, value);
      requestHeaders.set('Authorization', `Bearer ${lease.accessToken}`);
      return await fetch(target, { ...init, headers: requestHeaders, redirect: 'error' });
    };
    let lease = await lookup();
    let response = await send(lease);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      await requestAuth.reportConnectedAccountAuthFailure({ credentialContext: lease.credentialContext, signal,
        normalizedFailure: { class: 'authentication', evidence: { limitCategory: 'auth_invalid', quotaScope: 'account',
          httpStatus: 401, evidenceSource: { kind: 'structured' } } } });
      lease = await lookup();
      response = await send(lease);
    }
    if (response.status === 403) {
      const challenge = extractWWWAuthenticateParams(response);
      if (challenge.error === 'insufficient_scope') {
        await response.body?.cancel().catch(() => undefined);
        await requestAuth.reportConnectedAccountAuthFailure({ credentialContext: lease.credentialContext, signal,
          normalizedFailure: { class: 'insufficient_scope', requiredScopes: (challenge.scope ?? '').split(/\s+/u).filter(Boolean),
            evidence: { limitCategory: 'validation_failed', quotaScope: 'account', httpStatus: 403, evidenceSource: { kind: 'structured' } } } });
        throw new Error('This MCP server needs more access. Open Happier to grant it.');
      }
    }
    return response;
  } : undefined;

  const transport =
    config.transport === 'http'
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers }, ...(fetchRemote ? { fetch: fetchRemote } : {}) })
      : new SSEClientTransport(url, {
        requestInit: { headers },
        ...(fetchRemote ? { fetch: fetchRemote, eventSourceInit: { fetch: fetchRemote } } : {}),
      });

  try {
    await withMcpTimeout(client.connect(transport), {
      timeoutMs: MCP_BRIDGE_STARTUP_STEP_TIMEOUT_MS,
      label: 'happier_mcp_bridge_connect_timeout',
    });
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

async function main(): Promise<void> {
  const configPath = typeof process.env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE === 'string'
    ? process.env.HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE
    : '';
  if (!configPath) {
    writeStderr('[happier-mcp-remote-bridge] Missing HAPPIER_MCP_REMOTE_BRIDGE_CONFIG_FILE');
    process.exit(2);
  }

  let config: RemoteBridgeConfig;
  try {
    const raw = await readFile(configPath, 'utf8');
    config = RemoteBridgeConfigSchema.parse(JSON.parse(raw));
  } catch (err) {
    writeStderr(`[happier-mcp-remote-bridge] Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const remoteClient = await connectRemoteClient(config);
  const server = new McpServer({ name: 'Happier MCP Remote Bridge', version: '1.0.0' });
  const requestedSignal = await runMcpStdioBridgeLifecycle({
    stdin: process.stdin,
    start: async () => {
      const toolList = await withMcpTimeout(remoteClient.listTools(), {
        timeoutMs: MCP_BRIDGE_STARTUP_STEP_TIMEOUT_MS,
        label: 'happier_mcp_bridge_list_tools_timeout',
      });
      registerHappierBridgeTools(server, {
        tools: toolList.tools,
        callHttpTool: async (name, args, options) =>
          await callMcpToolWithResolvedTimeout({
            client: remoteClient,
            toolName: name,
            args,
            ...(options?.signal === undefined ? {} : { signal: options.signal }),
            ...(options?.requestMetadata === undefined ? {} : { requestMetadata: options.requestMetadata }),
            ...(options?.onprogress === undefined ? {} : { onprogress: options.onprogress }),
          }),
      });

      const stdio = new StdioServerTransport();
      await server.connect(stdio);
      return { transport: stdio, upstream: remoteClient };
    },
    closeServer: async () => await server.close(),
    closeUpstream: async () => await remoteClient.close(),
  });
  if (requestedSignal === 'SIGINT') process.exitCode = 130;
  if (requestedSignal === 'SIGTERM') process.exitCode = 143;
}

main().catch((err) => {
  writeStderr(`[happier-mcp-remote-bridge] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
