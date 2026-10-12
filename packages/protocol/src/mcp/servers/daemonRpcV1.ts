import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { AgentIdV1Schema } from '../../agents/agentIdV1.js';
import { McpServerRuleV1Schema, McpServerConfigOverrideFieldsV1Schema, ReachPlaceV1Schema,
  McpServerCatalogEntryTransportV1Schema, McpServerCatalogEntryV1Schema } from './settingsV1.js';
import { applyMcpServerConfigOverrideV1 } from './resolveMcpServerConfigForContextV1.js';

/**
 * The Agent a detected MCP server was discovered for. Detection identity is
 * Agent identity, so it stays open: any installed Agent — bundled or
 * externally contributed — can own an MCP discovery source.
 */
export const McpDetectedProviderV1Schema = AgentIdV1Schema;
export type McpDetectedProviderV1 = z.infer<typeof McpDetectedProviderV1Schema>;

export const DetectedMcpServerV1Schema = lazyZodSchema(() => z
  .object({
    provider: McpDetectedProviderV1Schema,
    name: z.string().min(1),
    transport: McpServerCatalogEntryTransportV1Schema,
    stdio: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()),
      })
      .optional(),
    remote: z
      .object({
        url: z.string().min(1),
        headers: z.array(z.string()),
      })
      .optional(),
    envKeys: z.array(z.string()),
    enabled: z.union([z.boolean(), z.null()]),
    // Older detection producers omit this presentation fact.
    loadedInHappierSessions: z.boolean().optional(),
    source: z.object({
      kind: z.enum(['user', 'project']),
      path: z.string().min(1),
    }).passthrough(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.transport === 'stdio') {
      if (!value.stdio) {
        ctx.addIssue({ code: 'custom', message: 'Missing stdio config', path: ['stdio'] });
      }
      if (value.remote) {
        ctx.addIssue({ code: 'custom', message: 'remote is not allowed for stdio servers', path: ['remote'] });
      }
      return;
    }
    if (value.stdio) {
      ctx.addIssue({ code: 'custom', message: 'stdio is not allowed for remote servers', path: ['stdio'] });
    }
    if (!value.remote) {
      ctx.addIssue({ code: 'custom', message: 'Missing remote config', path: ['remote'] });
    }
  }));

export type DetectedMcpServerV1 = z.infer<typeof DetectedMcpServerV1Schema>;

/**
 * `provider` is absent when the warning cannot be attributed to an Agent at
 * all — a discovery source that declares no resolvable Agent id, or a
 * detection request naming one. Such a source must stay visible as an
 * explicit incompleteness rather than collapsing into an empty result.
 */
export const DaemonMcpServersDetectWarningV1Schema = lazyZodSchema(() => z.object({
  provider: McpDetectedProviderV1Schema.optional(),
  code: z.enum(['read_failed', 'parse_failed', 'unsupported']),
  path: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
}).passthrough());
export type DaemonMcpServersDetectWarningV1 = z.infer<typeof DaemonMcpServersDetectWarningV1Schema>;

export const DaemonMcpServersDetectRequestSchema = lazyZodSchema(() => z
  .object({
    machineId: z.string().min(1),
    directory: z.string().min(1).max(10_000).optional(),
    providers: z.array(McpDetectedProviderV1Schema).optional(),
  })
  .passthrough());

export type DaemonMcpServersDetectRequest = z.infer<typeof DaemonMcpServersDetectRequestSchema>;

export const DaemonMcpServersDetectResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    servers: z.array(DetectedMcpServerV1Schema),
    warnings: z.array(DaemonMcpServersDetectWarningV1Schema).optional(),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum(['invalid_request', 'internal_error']),
    error: z.string().min(1),
  }).passthrough(),
]));
export type DaemonMcpServersDetectResponse = z.infer<typeof DaemonMcpServersDetectResponseSchema>;

export const DaemonMcpServersTestErrorCodeSchema = lazyZodSchema(() => z.enum([
  'invalid_request',
  'missing_credentials',
  'server_not_found',
  'binding_not_found',
  'server_disabled',
  'materialization_failed',
  'mcp_connect_failed',
  'mcp_list_tools_failed',
]));
export type DaemonMcpServersTestErrorCode = z.infer<typeof DaemonMcpServersTestErrorCodeSchema>;

export const DaemonMcpServersTestAuthoringRequestSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({
    t: z.literal('draft'),
    machineId: z.string().min(1),
    directory: z.string().min(1).max(10_000),
    server: McpServerCatalogEntryV1Schema,
    binding: McpServerRuleV1Schema.nullish(),
  }).passthrough(),
  z.object({
    t: z.literal('byId'),
    machineId: z.string().min(1),
    directory: z.string().min(1).max(10_000),
    serverId: z.string().min(1),
    bindingId: z.string().min(1).optional(),
  }).passthrough(),
]));
// Exact 0.2 RPC ingress; current Actions and catalog rows never author this field.
// Provenance: ../0.2 cd2bb4d853a259ae00ebc3e5981224e3e4bb5380,
// daemonRpcV1.ts:98–107 and McpServerTestPanel.tsx:136–141. Remove with 0.2 client support.
const retainedDraftTestRequest = lazyZodSchema(() => DaemonMcpServersTestAuthoringRequestSchema.options[0].extend({
  binding: McpServerRuleV1Schema.omit({ agentId: true }).extend({
    target: z.union([ReachPlaceV1Schema.options[0], ReachPlaceV1Schema.options[1], ReachPlaceV1Schema.options[3]]),
    overrides: McpServerConfigOverrideFieldsV1Schema.optional(),
  }).strict().nullish(),
}));
export const DaemonMcpServersTestRequestSchema = lazyZodSchema(() => z.preprocess(raw => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('t' in raw) || raw.t !== 'draft'
    || !('binding' in raw) || !raw.binding || typeof raw.binding !== 'object' || !('overrides' in raw.binding)) return raw;
  const retained = retainedDraftTestRequest.safeParse(raw);
  if (!retained.success || !retained.data.binding) return raw;
  const { overrides, ...binding } = retained.data.binding;
  // Draft Test supplies exactly one binding. Folding its configuration preserves
  // the predecessor winner's effect; the sole reach owner still checks its place.
  return { ...retained.data, server: applyMcpServerConfigOverrideV1(retained.data.server, overrides), binding };
}, DaemonMcpServersTestAuthoringRequestSchema));
export type DaemonMcpServersTestRequest = z.infer<typeof DaemonMcpServersTestRequestSchema>;

export const DaemonMcpServersTestResponseSchema = lazyZodSchema(() => z.union([
  z.object({
    ok: z.literal(true),
    toolCount: z.number().int().min(0),
    toolNamesSample: z.array(z.string()).optional(),
    durationMs: z.number().int().min(0),
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    errorCode: DaemonMcpServersTestErrorCodeSchema,
    error: z.string().min(1),
    durationMs: z.number().int().min(0),
  }).passthrough(),
]));
export type DaemonMcpServersTestResponse = z.infer<typeof DaemonMcpServersTestResponseSchema>;
