import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolAnnotationsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';

import type { McpServerConfig } from '@/agent';
import { withMcpTimeout } from '@/mcp/runtime/withMcpTimeout';
import { appendBoundedStderrTail, sanitizeChildStderrTail } from '@/daemon/spawn/childStderrDiagnostic';
import type { ProviderStreamingSanitizer } from '@/providers/spawn/redaction';
import { StdioMcpServerStartupFailureSchema, type StdioMcpServerStartupFailure } from '@/mcp/launchers/stdioMcpServerStartupFailure';

export type McpServerProbeTool = Readonly<{
  name: string; title?: string; description?: string; annotations?: McpToolAnnotationsV1;
  inputSchema: Tool['inputSchema'];
}>;
export type McpServerProbeResult = Readonly<{
  tools: readonly McpServerProbeTool[]; protocolVersion?: string;
  serverInfo?: Readonly<{ name: string; version?: string }>; instructions?: string; stderrTail?: string;
}>;

export class McpServerProbeError extends Error {
  readonly phase: 'connect' | 'list_tools';
  readonly stderrTail: string | undefined;
  readonly spawnFailure: StdioMcpServerStartupFailure | undefined;

  constructor(cause: unknown, phase: 'connect' | 'list_tools', stderrTail: string | undefined, spawnFailure?: StdioMcpServerStartupFailure) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'McpServerProbeError';
    this.phase = phase;
    this.stderrTail = stderrTail;
    this.spawnFailure = spawnFailure;
  }
}

function resolveEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export async function probeMcpStdioServerTools(params: Readonly<{
  config: McpServerConfig;
  baseEnv?: NodeJS.ProcessEnv;
  connectTimeoutMs?: number;
  listToolsTimeoutMs?: number;
  signal?: AbortSignal;
  sanitizeDiagnosticText?: (value: string) => string;
  createDiagnosticStreamingSanitizer?: () => ProviderStreamingSanitizer;
}>): Promise<McpServerProbeResult> {
  params.signal?.throwIfAborted();
  const [{ Client }, { StdioClientTransport }, { McpError }, { getDisplayName }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
    import('@modelcontextprotocol/sdk/shared/metadataUtils.js'),
  ]);
  params.signal?.throwIfAborted();
  const baseEnv = params.baseEnv ?? process.env;
  const env = params.config.env ? { ...resolveEnvRecord(baseEnv), ...params.config.env } : resolveEnvRecord(baseEnv);

  let protocolVersion: string | undefined;
  const transport = Object.assign(new StdioClientTransport({
    command: params.config.command,
    args: params.config.args ?? [],
    env,
    stderr: 'pipe',
  }), { setProtocolVersion: (version: string) => { protocolVersion = version; } });
  let capturedStderr = '';
  const streamingSanitizer = params.createDiagnosticStreamingSanitizer?.();
  const onStderr = (chunk: string | Uint8Array) => {
    capturedStderr = appendBoundedStderrTail(capturedStderr, streamingSanitizer ? streamingSanitizer.push(chunk) : chunk);
  };
  transport.stderr?.on('data', onStderr);
  const stderrTail = () => sanitizeChildStderrTail(capturedStderr, params.sanitizeDiagnosticText ?? (value => value)) ?? undefined;

  const client = new Client({ name: 'happier-mcp-test', version: '1.0.0' }, { capabilities: {} });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= client.close().catch(() => {});
  const finishStderr = () => {
    transport.stderr?.off('data', onStderr);
    if (streamingSanitizer) capturedStderr = appendBoundedStderrTail(capturedStderr, streamingSanitizer.flush());
  };
  const onAbort = () => { void close(); };
  params.signal?.addEventListener('abort', onAbort, { once: true });

  let phase: 'connect' | 'list_tools' = 'connect';
  try {
    // Installed SDK 1.25.3 has no server/discover contract. Its connect owner
    // performs the supported initialize fallback and reports the negotiated version.
    // Keep the caller's cancellation and the SDK request lifetime authoritative.
    // A Test-only default cutoff can expire while the shared remote bridge is
    // still within its startup and per-request credential lookup lifetimes.
    await withMcpTimeout(client.connect(transport, { signal: params.signal }), {
      timeoutMs: params.connectTimeoutMs ?? 0,
      label: 'mcp_connect_timeout',
    });
    phase = 'list_tools';
    const tools: McpServerProbeTool[] = [];
    let cursor: string | undefined;
    do {
      params.signal?.throwIfAborted();
      const page = await withMcpTimeout(client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal: params.signal },
      ), {
        timeoutMs: params.listToolsTimeoutMs ?? 0,
        label: 'mcp_list_tools_timeout',
      });
      params.signal?.throwIfAborted();
      tools.push(...page.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema,
        ...(tool.title === undefined && tool.annotations?.title === undefined ? {} : { title: getDisplayName(tool) }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.annotations === undefined ? {} : { annotations: {
          ...(tool.annotations.readOnlyHint === undefined ? {} : { readOnlyHint: tool.annotations.readOnlyHint }),
          ...(tool.annotations.destructiveHint === undefined ? {} : { destructiveHint: tool.annotations.destructiveHint }),
          ...(tool.annotations.idempotentHint === undefined ? {} : { idempotentHint: tool.annotations.idempotentHint }),
          ...(tool.annotations.openWorldHint === undefined ? {} : { openWorldHint: tool.annotations.openWorldHint }),
        } }),
      })));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const server = client.getServerVersion();
    const instructions = client.getInstructions();
    await close();
    finishStderr();
    params.signal?.throwIfAborted();
    const diagnostic = stderrTail();
    return { tools, ...(protocolVersion === undefined ? {} : { protocolVersion }),
      ...(server === undefined ? {} : { serverInfo: { name: server.name, version: server.version } }),
      ...(instructions === undefined ? {} : { instructions }), ...(diagnostic ? { stderrTail: diagnostic } : {}) };
  } catch (error) {
    await close();
    finishStderr();
    const failure = error instanceof McpError ? StdioMcpServerStartupFailureSchema.safeParse(error.data) : null;
    throw new McpServerProbeError(error, phase, stderrTail(), failure?.success ? failure.data : undefined);
  } finally {
    params.signal?.removeEventListener('abort', onAbort);
    await close();
    transport.stderr?.off('data', onStderr);
  }
}
