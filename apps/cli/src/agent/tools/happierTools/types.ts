import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export type HappierBuiltInToolDefinition = Readonly<{
  name: string;
  title: string;
  description: string;
  toolId?: string;
  actionId?: string;
  inputSchema: unknown;
  contextualDefaults?: import('@happier-dev/protocol').ActionContextualDefaults;
  outputSchema?: unknown;
  safety?: 'safe' | 'danger';
  inputHints?: unknown;
  examples?: unknown;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  availability?: unknown;
  annotations?: ToolAnnotations;
  _meta?: Readonly<Record<string, unknown>>;
}>;

export type HappierBuiltInToolDispatchResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string; candidates?: string[]; details?: unknown }>;
