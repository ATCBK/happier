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
import {
  CallToolResultSchema, InitializeResultSchema, JSONRPCMessageSchema,
  JSONRPCNotificationSchema, JSONRPCRequestSchema, JSONRPCResultResponseSchema,
  ListToolsResultSchema, ProgressNotificationSchema, ProgressTokenSchema, RequestIdSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { createConnectedAccountRequestAuthClient } from '@happier-dev/plugin-sdk/connected-accounts/request-auth';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';
import { z } from 'zod';

import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { withMcpTimeout } from '@/mcp/runtime/withMcpTimeout';
import { runMcpStdioBridgeLifecycle } from '@/mcp/runtime/runMcpStdioBridgeLifecycle';
import { registerHappierBridgeTools } from './registerHappierBridgeTools';
import { MCP_REQUEST_AUTH_PURPOSE } from '@/mcp/runtime/mcpRequestAuth';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { readCredentialRedactionValues } from '@/plugins/runtime/invocation/services/credentialRedactionValues';

const MCP_BRIDGE_STARTUP_STEP_TIMEOUT_MS = 60_000;
// Keep already-issued values protected through late responses and credential
// rotations; this lease ends with this single bridge process, not a request.
const outputRedaction = createProviderRedactionLease({ values: [] });

const BridgeOutputSchema = z.union([
  JSONRPCResultResponseSchema.extend({ result: z.union([InitializeResultSchema, ListToolsResultSchema, CallToolResultSchema]) }),
  JSONRPCNotificationSchema.extend(ProgressNotificationSchema.shape),
  JSONRPCMessageSchema,
]);

// Preserve only SDK-owned fields, literals and correlation facts. Dictionary
// keys and string payloads use the same credential lease as stderr; redacting
// the serialized message would corrupt syntax when a secret is "content".
function projectRedactedBridgeOutput(value: unknown, schema?: z.core.$ZodType): unknown {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable || schema instanceof z.ZodDefault) {
    return projectRedactedBridgeOutput(value, schema.unwrap());
  }
  if (schema === RequestIdSchema || schema === ProgressTokenSchema
    || schema === InitializeResultSchema.shape.protocolVersion
    || schema === JSONRPCNotificationSchema.shape.method || schema === JSONRPCRequestSchema.shape.method
    || schema instanceof z.ZodLiteral || schema instanceof z.ZodEnum) return value;
  if (schema instanceof z.ZodUnion) {
    const option = schema.options.find(candidate => z.safeParse(candidate, value).success);
    return projectRedactedBridgeOutput(value, option);
  }
  if (typeof value === 'string') return outputRedaction.redact(value);
  if (Array.isArray(value)) {
    const element = schema instanceof z.ZodArray ? schema.element : undefined;
    return value.map(item => projectRedactedBridgeOutput(item, element));
  }
  if (value === null || typeof value !== 'object') return value;
  const fields = schema instanceof z.ZodObject ? schema.shape : undefined;
  const entrySchema = schema instanceof z.ZodRecord ? schema.valueType : undefined;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    fields && Object.hasOwn(fields, key) ? key : outputRedaction.redact(key),
    // Remote metadata is an arbitrary private dictionary, including any keys
    // whose spelling happens to match a protocol field.
    projectRedactedBridgeOutput(entry, key === '_meta' ? undefined : fields?.[key] ?? entrySchema),
  ]));
}

const RemoteBridgeConfigSchema = z.object({
  transport: z.enum(['http', 'sse']),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional().default({}),
  redactionValues: z.array(z.string().min(1)).optional().default([]),
  auth: z.object({ capabilityFile: z.string().min(1), resource: z.string().url() }).strict().optional(),
});

type RemoteBridgeConfig = z.infer<typeof RemoteBridgeConfigSchema>;

class McpResourceMismatchError extends Error {
  readonly code = 'mcp_resource_mismatch';
  constructor() { super('mcp_resource_mismatch'); this.name = 'McpResourceMismatchError'; }
}

function writeStderr(line: string): void {
  try {
    const safeLine = outputRedaction.redact(line);
    process.stderr.write(safeLine.endsWith('\n') ? safeLine : `${safeLine}\n`);
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
    const destination = canonicalMcpOAuthResourceUrlV1(String(target));
    const resource = canonicalMcpOAuthResourceUrlV1(config.auth!.resource);
    // SSE advertises a same-origin POST endpoint after the initial connection.
    // The capability remains bound to the exact initial resource above; this
    // transport path does not select a different grant or bearer audience.
    if (config.transport === 'sse'
      ? new URL(destination).origin !== url.origin
      : destination !== resource) throw new McpResourceMismatchError();
    const signal = init?.signal ?? undefined;
    const lookup = async () => {
      try {
        const lease = await requestAuth.lookupConnectedAccountRequestAuth({ purpose: MCP_REQUEST_AUTH_PURPOSE, signal });
        outputRedaction.add([lease.accessToken, JSON.stringify(lease.accessToken).slice(1, -1)]);
        return lease;
      }
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

  outputRedaction.add(config.redactionValues.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]));
  outputRedaction.add(Object.values(config.headers).flatMap(value =>
    readCredentialRedactionValues({ rawCredential: value, authorizationValue: value })
      .flatMap(credential => [credential, JSON.stringify(credential).slice(1, -1)]),
  ));
  const remoteClient = await connectRemoteClient(config);
  const serverInfo = remoteClient.getServerVersion();
  if (!serverInfo) {
    await remoteClient.close();
    throw new Error('Remote MCP server did not provide its identity.');
  }
  const instructions = remoteClient.getInstructions();
  const server = new McpServer(serverInfo, { ...(instructions === undefined ? {} : { instructions }) });
  const requestedSignal = await runMcpStdioBridgeLifecycle({
    stdin: process.stdin,
    start: async () => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await withMcpTimeout(remoteClient.listTools(cursor === undefined ? undefined : { cursor }), {
          timeoutMs: MCP_BRIDGE_STARTUP_STEP_TIMEOUT_MS,
          label: 'happier_mcp_bridge_list_tools_timeout',
        });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      registerHappierBridgeTools(server, {
        tools,
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
      // One actual Agent-facing output boundary covers tool metadata, results,
      // protocol errors and progress without choosing or filtering any tools.
      const send = stdio.send.bind(stdio);
      stdio.send = async (message) => await send(JSONRPCMessageSchema.parse(
        projectRedactedBridgeOutput(message, BridgeOutputSchema),
      ));
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
}).finally(() => outputRedaction.close());
