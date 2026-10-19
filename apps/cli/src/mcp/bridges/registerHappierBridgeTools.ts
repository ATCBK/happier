import { z } from 'zod/mini';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ProgressNotification, RequestMeta } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '@/ui/logger';
import { projectMcpToolInputJsonSchema } from '@/mcp/server/projectMcpToolInputJsonSchema';

type BridgeRequestExtra = Readonly<{
  signal?: AbortSignal;
  _meta?: RequestMeta;
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}>;

export type HappierBridgeCallOptions = Readonly<{
  signal?: AbortSignal;
  requestMetadata?: RequestMeta;
  onprogress?: RequestOptions['onprogress'];
}>;

export type HappierBridgeToolCaller = (
  name: string,
  args: unknown,
  options?: HappierBridgeCallOptions,
) => ReturnType<Client['callTool']>;

// Tool registration for the host-owned Happier MCP bridge.
type ToolRegistrar = Readonly<{
  registerTool: (
    name: string,
    definition: any,
    handler: (args: any, extra?: BridgeRequestExtra) => Promise<any>,
  ) => void;
}>;

function toBridgeSchema(schema: unknown, input = false): z.core.$ZodType {
  if (schema instanceof z.core.$ZodType) {
    return schema;
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return z.looseObject({});
  }

  // MCP discovery returns JSON Schema while the high-level MCP server accepts
  // Zod registrations. This proxy deliberately validates permissively and
  // preserves the discovered schema for presentation; the remote server is
  // the authoritative validation and execution owner.
  const adapter = z.looseObject({});
  adapter._zod.processJSONSchema = (_ctx, json) => {
    Object.assign(json, input ? projectMcpToolInputJsonSchema(schema as Readonly<Record<string, unknown>>) : schema);
  };
  return adapter;
}

export function forwardHappierBridgeTool(
  name: string,
  args: unknown,
  extra: BridgeRequestExtra | undefined,
  callHttpTool: HappierBridgeToolCaller,
) {
  return forwardTool(name, callHttpTool)(args, extra);
}

function forwardTool(name: string, callHttpTool: HappierBridgeToolCaller) {
  return async (args: unknown, extra?: BridgeRequestExtra) => {
    const progressToken = extra?._meta?.progressToken;
    const pendingProgressNotifications: Promise<void>[] = [];
    const onprogress = (
      (typeof progressToken === 'string' || typeof progressToken === 'number')
      && typeof extra?.sendNotification === 'function'
    )
      ? (progress: Readonly<{ progress: number; total?: number; message?: string }>) => {
        const notification = extra.sendNotification?.({
          method: 'notifications/progress',
          params: { ...progress, progressToken },
        }).catch((error) => {
          logger.debug('[happierMCP] Failed to forward tool progress', error);
        });
        if (notification) pendingProgressNotifications.push(notification);
      }
      : undefined;
    try {
      const options = {
        ...(extra?.signal === undefined ? {} : { signal: extra.signal }),
        ...(extra?._meta === undefined ? {} : { requestMetadata: extra._meta }),
        ...(onprogress === undefined ? {} : { onprogress }),
      };
      const result = Object.keys(options).length === 0
        ? await callHttpTool(name, args)
        : await callHttpTool(name, args, options);
      await Promise.all(pendingProgressNotifications);
      return result;
    } catch (error) {
      if (extra?.signal?.aborted === true) throw error;
      return {
        content: [
          { type: 'text', text: `Failed to call tool ${name}: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  };
}

export function registerHappierBridgeTools(
  server: ToolRegistrar,
  deps: Readonly<{
    callHttpTool: HappierBridgeToolCaller;
    tools: readonly Readonly<{
      name: string;
      title?: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
      annotations?: unknown;
      _meta?: Record<string, unknown>;
    }>[];
  }>,
): void {
  for (const tool of deps.tools) {
    const meta = {
      description: tool.description ?? tool.title ?? tool.name,
      title: tool.title ?? tool.name,
      inputSchema: toBridgeSchema(tool.inputSchema, true),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: toBridgeSchema(tool.outputSchema) }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
    };

    server.registerTool(tool.name, meta, forwardTool(tool.name, deps.callHttpTool));
  }
}
