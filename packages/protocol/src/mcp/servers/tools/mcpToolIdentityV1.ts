import type { McpToolAnnotationsV1 } from '../settingsV1.js';
import type { McpToolDecisionV1 } from './resolveMcpToolDecisionV1.js';
import { McpToolAnnotationsV1Schema } from '../settingsV1.js';
import { McpToolDecisionV1Schema } from './resolveMcpToolDecisionV1.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';
export type McpToolIdentityV1 = Readonly<{ server: string; tool: string }>;
export type ResolvedMcpToolIdentityV1 = McpToolIdentityV1 & Readonly<{
  item: Readonly<{ serverId: string; plugin?: Readonly<{ pluginId: string; localId: string }> }>;
  serverTitle: string; toolTitle?: string; annotations?: McpToolAnnotationsV1; decision: McpToolDecisionV1;
}>;
export const ResolvedMcpToolIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  server: z.string().check(z.minLength(1)), tool: z.string().check(z.minLength(1)),
  item: z.strictObject({ serverId: z.string().check(z.minLength(1)), plugin: z.optional(z.strictObject({ pluginId: z.string().check(z.minLength(1)), localId: z.string().check(z.minLength(1)) })) }),
  serverTitle: z.string(), toolTitle: z.optional(z.string()), annotations: z.optional(McpToolAnnotationsV1Schema), decision: McpToolDecisionV1Schema,
}));
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
