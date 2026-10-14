/**
 * Happier MCP STDIO Bridge
 *
 * STDIO MCP server that forwards tools to an existing Happier HTTP MCP server
 * using the StreamableHTTPClientTransport.
 *
 * Configure the target HTTP MCP URL via env var `HAPPIER_HTTP_MCP_URL` or
 * via CLI flag `--url <http://127.0.0.1:PORT>`.
 *
 * Note: This process must not print to stdout as it would break MCP STDIO.
 *
 * This is host MCP bridge infrastructure, not provider runtime behavior.
 */

import '../../configureZodLocale';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { forwardHappierBridgeTool } from './registerHappierBridgeTools';
import { registerHappierMcpResources } from '@/mcp/resources/registerHappierMcpResources';
import { callMcpToolWithResolvedTimeout } from '@/mcp/mcpToolCallRequestOptions';
import { isActionEnabledByEnv } from '@/settings/actionsSettings';
import { isMcpToolNameAlias, projectMcpToolNames } from '@/mcp/runtime/projectMcpToolNames';
import { runMcpStdioBridgeLifecycle } from '@/mcp/runtime/runMcpStdioBridgeLifecycle';

function parseArgs(argv: string[]): { url: string | null; toolNameMaxLength?: number } {
  let url: string | null = null;
  let toolNameMaxLength: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) {
      url = argv[i + 1];
      i++;
    } else if (a === '--tool-name-max-length') {
      toolNameMaxLength = Number(argv[++i]);
      projectMcpToolNames([], toolNameMaxLength);
    }
  }
  return { url, ...(toolNameMaxLength === undefined ? {} : { toolNameMaxLength }) };
}

async function main() {
  // Resolve target HTTP MCP URL
  const { url: urlFromArgs, toolNameMaxLength } = parseArgs(process.argv.slice(2));
  const baseUrl = urlFromArgs || process.env.HAPPIER_HTTP_MCP_URL || '';

  if (!baseUrl) {
    // Write to stderr; never stdout.
    process.stderr.write(
      '[happier-mcp] Missing target URL. Set HAPPIER_HTTP_MCP_URL or pass --url <http://127.0.0.1:PORT>\n'
    );
    process.exit(2);
  }

  let httpClient: Client | null = null;
  let httpClientPromise: Promise<Client> | null = null;

  async function ensureHttpClient(): Promise<Client> {
    if (httpClient) return httpClient;
    if (httpClientPromise) return await httpClientPromise;
    const pending = (async () => {
      const client = new Client(
        { name: 'happier-stdio-bridge', version: '1.0.0' },
        { capabilities: {} }
      );
      const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
      try {
        await client.connect(transport);
        httpClient = client;
        return client;
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
    })();
    httpClientPromise = pending;
    try {
      return await pending;
    } catch (error) {
      httpClientPromise = null;
      throw error;
    }
  }

  // Create STDIO MCP server
  const server = new McpServer({
    name: 'Happier MCP Bridge',
    version: '1.0.0',
  });
  // Initialize the stdio transport without waiting for two serial loopback
  // requests. Discovery and execution still go to the exact upstream runtime.
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await (await ensureHttpClient()).listTools(request.params, { signal: extra.signal });
    const names = projectMcpToolNames(result.tools.map(tool => tool.name), toolNameMaxLength);
    return { ...result, tools: result.tools.map((tool, index) => ({ ...tool, name: names[index]!.projectedName })) };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let originalName = request.params.name;
    if (toolNameMaxLength !== undefined && isMcpToolNameAlias(originalName)) {
      const client = await ensureHttpClient();
      const originalNames: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor }, { signal: extra.signal });
        originalNames.push(...page.tools.map(tool => tool.name));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const match = projectMcpToolNames(originalNames, toolNameMaxLength).find(tool => tool.projectedName === request.params.name);
      if (!match) throw new Error('MCP transport tool is no longer advertised');
      originalName = match.originalName;
    }
    return await forwardHappierBridgeTool(
      originalName,
      request.params.arguments,
      extra,
      async (name, args, options) => {
        const client = await ensureHttpClient();
        return await callMcpToolWithResolvedTimeout({
          client,
          toolName: name,
          args,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(options?.requestMetadata === undefined ? {} : { requestMetadata: options.requestMetadata }),
          ...(options?.onprogress === undefined ? {} : { onprogress: options.onprogress }),
        });
      },
    );
  });
  registerHappierMcpResources(server as any, {
    isActionEnabled: (id) => isActionEnabledByEnv(id, { surface: 'agent' }),
  });

  const requestedSignal = await runMcpStdioBridgeLifecycle({
    stdin: process.stdin,
    start: async () => {
      const stdio = new StdioServerTransport();
      await server.connect(stdio);
      return { transport: stdio };
    },
    closeServer: async () => await server.close(),
    closeUpstream: async () => await httpClient?.close(),
  });
  if (requestedSignal === 'SIGINT') process.exitCode = 130;
  if (requestedSignal === 'SIGTERM') process.exitCode = 143;
}

// Start and surface fatal errors to stderr only
main().catch((err) => {
  try {
    process.stderr.write(`[happier-mcp] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  } finally {
    process.exit(1);
  }
});
