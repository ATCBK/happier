import type { McpToolAnnotationsV1 } from '../settingsV1.js';
import type { McpToolDecisionV1 } from './resolveMcpToolDecisionV1.js';
import { McpToolAnnotationsV1Schema } from '../settingsV1.js';
import { McpToolDecisionV1Schema } from './resolveMcpToolDecisionV1.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';
export type McpToolIdentityV1 = Readonly<{ server: string; tool: string }>;
export type ResolvedMcpToolIdentityV1 = McpToolIdentityV1 & Readonly<{
  item: Readonly<{ serverId: string; plugin?: Readonly<{ pluginId: string; localId: string }> }>;
  serverTitle: string; toolTitle?: string; annotations?: McpToolAnnotationsV1; decision: McpToolDecisionV1;
}>;
export const ResolvedMcpToolIdentityV1Schema = lazyZodSchema(() => z.object({
  server: z.string().min(1), tool: z.string().min(1),
  item: z.object({ serverId: z.string().min(1), plugin: z.object({ pluginId: z.string().min(1), localId: z.string().min(1) }).strict().optional() }).strict(),
  serverTitle: z.string(), toolTitle: z.string().optional(), annotations: McpToolAnnotationsV1Schema.optional(), decision: McpToolDecisionV1Schema,
}).strict());
export function parseMcpToolWireNameV1(name: string, knownServerKeys: ReadonlySet<string>): McpToolIdentityV1 | null {
  if (!name.startsWith('mcp__')) return null;
  let longest: McpToolIdentityV1 | null = null;
  for (const server of knownServerKeys) {
    if (server === 'happier' || !server) continue;
    const prefix = `mcp__${server}__`;
    if (!name.startsWith(prefix)) continue;
    if (!longest || server.length > longest.server.length) longest = { server, tool: name.slice(prefix.length) };
  }
  return longest?.tool ? longest : null;
}
