import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { McpServerConfig } from '@/agent';
import { withMcpTimeout } from '@/mcp/runtime/withMcpTimeout';

type ToolInfo = Readonly<{ name: string }>;

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
}>): Promise<ReadonlyArray<ToolInfo>> {
  params.signal?.throwIfAborted();
  const baseEnv = params.baseEnv ?? process.env;
  const env = params.config.env ? { ...resolveEnvRecord(baseEnv), ...params.config.env } : resolveEnvRecord(baseEnv);

  const transport = new StdioClientTransport({
    command: params.config.command,
    args: params.config.args ?? [],
    env,
  });

  const client = new Client({ name: 'happier-mcp-test', version: '1.0.0' }, { capabilities: {} });
  let abortedClose: Promise<void> | null = null;
  const onAbort = () => {
    abortedClose = client.close().catch(() => {});
  };
  params.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await withMcpTimeout(client.connect(transport, { signal: params.signal }), {
      timeoutMs: params.connectTimeoutMs ?? 15_000,
      label: 'mcp_connect_timeout',
    });
    const tools: ToolInfo[] = [];
    let cursor: string | undefined;
    do {
      params.signal?.throwIfAborted();
      const page = await withMcpTimeout(client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal: params.signal },
      ), {
        timeoutMs: params.listToolsTimeoutMs ?? 15_000,
        label: 'mcp_list_tools_timeout',
      });
      params.signal?.throwIfAborted();
      tools.push(...page.tools.map(tool => ({ name: tool.name })));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return tools;
  } finally {
    params.signal?.removeEventListener('abort', onAbort);
    await (abortedClose ?? client.close().catch(() => {}));
  }
}
