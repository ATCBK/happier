import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { McpRemoteUrlV1Schema } from '../remoteUrlV1.js';
import { ReachPlaceV1Schema } from '../../reach/reachPlaceV1.js';
import { ReachRuleV1Schema } from '../../reach/reachRuleV1.js';
import { reachRuleKeyV1 } from '../../reach/reachRulesChangeV1.js';
import { ValueRefV1Schema } from '../../valueRefs/valueRefV1.js';
import { RegistryProvenanceV1Schema } from '../../registries/registryItemsV1.js';
import { RegistryUpstreamV1Schema } from '../../registries/registryUpstreamV1.js';
import type { PluginMcpServerContributionV1 } from '../../plugins/contributions/mcp.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolUnion } from '../../plugins/actions/protocolComposableSchema.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
export { ReachPlaceV1Schema } from '../../reach/reachPlaceV1.js';
export type { ReachPlaceV1 } from '../../reach/reachPlaceV1.js';

const SERVER_NAME_REGEX = /^[a-z0-9_-]+$/;
const RESERVED_SERVER_NAMES = new Set(['happier', '__proto__', 'prototype', 'constructor']);

const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_KEY_REGEX = /^[A-Za-z0-9-]+$/;

const McpEnvVarKeyV1Schema = lazyZodSchema(() => z.string().regex(ENV_KEY_REGEX, 'Invalid environment variable name'));
const McpHeaderKeyV1Schema = lazyZodSchema(() => z.string().regex(HEADER_KEY_REGEX, 'Invalid header name'));

export const McpServerCatalogEntryTransportV1Schema = lazyZodSchema(() => z.enum(['stdio', 'http', 'sse']));
export type McpServerCatalogEntryTransportV1 = z.infer<typeof McpServerCatalogEntryTransportV1Schema>;

const McpValueRefOrNullV1Schema = lazyZodSchema(() => z.union([ValueRefV1Schema, z.null()]));
const McpWorkingFolderPathV1Schema = lazyZodSchema(() => z.object({ t: z.literal('path'), path: z.string().min(1) }).strict());
const McpToolSettingV1Definition = defineProtocolUnion([
  defineProtocolLiteral('off'), defineProtocolLiteral('ask'), defineProtocolLiteral('allow'),
]);
export const McpToolSettingV1Schema = asProtocolZod(McpToolSettingV1Definition);
export type McpToolSettingV1 = z.infer<typeof McpToolSettingV1Schema>;
// MCP tool names are opaque external keys, including valid names such as
// '__proto__'. The composable dictionary preserves and validates every own key.
export const McpToolSettingsV1Schema: z.ZodType<Readonly<Record<string, McpToolSettingV1>>, Readonly<Record<string, McpToolSettingV1>>> = asProtocolZod(defineProtocolObject({}, {
  policy: 'additive-open/preserve', additionalProperties: McpToolSettingV1Definition,
}));
const McpToolSettingsPatchV1Schema: z.ZodType<Readonly<Record<string, McpToolSettingV1 | 'inherit'>>, Readonly<Record<string, McpToolSettingV1 | 'inherit'>>> = asProtocolZod(defineProtocolObject({}, {
  policy: 'additive-open/preserve', additionalProperties: defineProtocolUnion([McpToolSettingV1Definition, defineProtocolLiteral('inherit')]),
}));
export const McpServerToolPolicyV1Schema = lazyZodSchema(() => z.object({
  default: z.enum(['ask', 'allow_read_only', 'allow_all']), overrides: McpToolSettingsV1Schema,
}).strict());
export type McpServerToolPolicyV1 = z.infer<typeof McpServerToolPolicyV1Schema>;
export const McpServerToolSettingsPatchV1Schema = lazyZodSchema(() => z.object({
  default: McpServerToolPolicyV1Schema.shape.default.optional(),
  tools: McpToolSettingsPatchV1Schema.optional(),
}).strict());
export type McpServerToolSettingsPatchV1 = z.infer<typeof McpServerToolSettingsPatchV1Schema>;
export const McpToolAnnotationsV1Schema = lazyZodSchema(() => z.object({
  readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(), openWorldHint: z.boolean().optional(),
}).strict());
export type McpToolAnnotationsV1 = z.infer<typeof McpToolAnnotationsV1Schema>;
export const McpServerToolsSnapshotV1Schema = lazyZodSchema(() => z.object({
  checkedAt: z.number(), machineId: z.string().min(1), protocolVersion: z.string().optional(),
  serverInfo: z.object({ name: z.string(), version: z.string().optional() }).strict().optional(),
  instructions: z.string().optional(), tools: z.array(z.object({
    name: z.string(), title: z.string().optional(), description: z.string().optional(),
    annotations: McpToolAnnotationsV1Schema.optional(), tokens: z.number().nonnegative(),
  }).strict()),
}).strict());
export type McpServerToolsSnapshotV1 = z.infer<typeof McpServerToolsSnapshotV1Schema>;
export const McpServerPluginSettingsV1Schema = lazyZodSchema(() => z.object({
  tools: McpServerToolPolicyV1Schema.optional(), toolsSnapshot: McpServerToolsSnapshotV1Schema.optional(),
}).strict());
export const McpServerPluginSettingsMapV1Schema = lazyZodSchema(() => z.record(
  z.string().refine(isMcpPluginItemIdV1, 'Invalid plugin MCP item id'), McpServerPluginSettingsV1Schema,
));
export const McpServerConfigOverrideFieldsV1Schema = lazyZodSchema(() => z.object({
  stdio: z.object({ command: z.string().min(1).optional(), args: z.array(z.string()).optional(),
    cwd: McpWorkingFolderPathV1Schema.optional() }).strict().optional(),
  remote: z.object({ url: McpRemoteUrlV1Schema.optional(), headersPatch: z.record(McpHeaderKeyV1Schema, McpValueRefOrNullV1Schema).optional() }).strict().optional(),
  envPatch: z.record(McpEnvVarKeyV1Schema, McpValueRefOrNullV1Schema).optional(),
}).strict());
export type McpServerConfigOverrideFieldsV1 = z.infer<typeof McpServerConfigOverrideFieldsV1Schema>;
export const McpServerConfigOverrideV1Schema = lazyZodSchema(() => McpServerConfigOverrideFieldsV1Schema.extend({
  target: z.union([ReachPlaceV1Schema.options[1], ReachPlaceV1Schema.options[3]]),
}).strict());
export type McpServerConfigOverrideV1 = z.infer<typeof McpServerConfigOverrideV1Schema>;

export const McpServerCatalogEntryV1Schema = lazyZodSchema(() => z
  .object({
    id: z.string().min(1),
    name: z
      .string()
      .min(1)
      .regex(SERVER_NAME_REGEX, 'Invalid MCP server name')
      .refine((value) => !RESERVED_SERVER_NAMES.has(value), 'Reserved MCP server name'),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    transport: McpServerCatalogEntryTransportV1Schema,
    stdio: z
      .object({
        command: z.string().min(1),
        args: z.array(z.string()),
        cwd: z.union([z.object({ t: z.literal('session') }).strict(), McpWorkingFolderPathV1Schema]).optional(),
      }).strict()
      .optional(),
    remote: z
      .object({
        url: McpRemoteUrlV1Schema,
        urlTemplate: ValueRefV1Schema.options[2].optional(),
        headers: z.record(McpHeaderKeyV1Schema, ValueRefV1Schema),
        auth: z.object({ kind: z.literal('oauth') }).strict().optional(),
      }).strict()
      .optional(),
    env: z.record(McpEnvVarKeyV1Schema, ValueRefV1Schema),
    configOverrides: z.array(McpServerConfigOverrideV1Schema).optional(),
    tools: McpServerToolPolicyV1Schema.optional(),
    toolsSnapshot: McpServerToolsSnapshotV1Schema.optional(),
    origin: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('registry'), provenance: RegistryProvenanceV1Schema,
        upstream: RegistryUpstreamV1Schema.optional() }).strict(),
      z.object({ kind: z.literal('machine'), machineId: z.string().min(1), agentId: z.string().min(1) }).strict(),
    ]).optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  }).strict()
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

export type McpServerCatalogEntryV1 = z.infer<typeof McpServerCatalogEntryV1Schema>;

export const McpServerRuleV1Schema = lazyZodSchema(() => ReachRuleV1Schema.extend({
  serverId: z.string().min(1),
}).strict());
export type McpServerRuleV1 = z.infer<typeof McpServerRuleV1Schema>;
export function mcpPluginItemIdV1(input: Readonly<{ pluginId: string; localId: string }>): string { return `plugin:${input.pluginId}/${input.localId}`; }
export function parseMcpPluginItemIdV1(value: string): Readonly<{ pluginId: string; localId: string }> | null {
  const match = /^plugin:([^/]+)\/(.+)$/.exec(value);
  if (!match) return null;
  const ref = PluginContributionIdentityV1Schema.safeParse({ pluginId: match[1], localId: match[2] });
  return ref.success ? ref.data : null;
}
export function isMcpPluginItemIdV1(value: string): boolean { return parseMcpPluginItemIdV1(value) !== null; }
export type McpPluginItemV1 = Readonly<{ itemId: string; name: string; title?: string; config: McpServerCatalogEntryV1; rules: readonly McpServerRuleV1[] }>;
export const McpPluginItemMetadataV1Schema = lazyZodSchema(() => z.object({
  id: z.string().refine(isMcpPluginItemIdV1), name: z.string().min(1), title: z.string().optional(),
  description: z.string().optional(), transport: McpServerCatalogEntryTransportV1Schema,
  source: z.object({ kind: z.literal('plugin'), pluginId: z.string().min(1), pluginName: z.string().min(1) }).strict(),
}).strict());
export type McpPluginItemMetadataV1 = z.infer<typeof McpPluginItemMetadataV1Schema>;
/** Declaration-only projection shared by client lists and runtime admission. */
export function projectMcpPluginItemMetadataV1(input: Readonly<{ pluginId: string; pluginName: string; server: PluginMcpServerContributionV1 }>): McpPluginItemMetadataV1 {
  const { server } = input;
  const localName = server.id.replaceAll('/', '_');
  const name = RESERVED_SERVER_NAMES.has(localName) ? `plugin_${localName}` : localName;
  return McpPluginItemMetadataV1Schema.parse({ id: mcpPluginItemIdV1({ pluginId: input.pluginId, localId: server.id }),
    name, title: typeof server.title === 'string' ? server.title : server.title.fallback,
    ...(server.description ? { description: typeof server.description === 'string' ? server.description : server.description.fallback } : {}),
    transport: server.kind === 'static' && server.transport.kind === 'stdio' ? 'stdio' : 'http',
    source: { kind: 'plugin', pluginId: input.pluginId, pluginName: input.pluginName } });
}

export function refineMcpServerCatalogV1(value: Readonly<{
  servers: readonly McpServerCatalogEntryV1[]; bindings: readonly McpServerRuleV1[];
}>, ctx: z.RefinementCtx): void {
  const serverIds = new Set<string>();
  const serverNames = new Set<string>();
  for (const [i, server] of value.servers.entries()) {
    if (serverIds.has(server.id)) ctx.addIssue({ code: 'custom', message: `Duplicate server id: ${server.id}`, path: ['servers', i, 'id'] });
    if (serverNames.has(server.name)) ctx.addIssue({ code: 'custom', message: `Duplicate server name: ${server.name}`, path: ['servers', i, 'name'] });
    serverIds.add(server.id); serverNames.add(server.name);
  }
  const bindingIds = new Set<string>();
  const ruleKeys = new Set<string>();
  for (const [i, binding] of value.bindings.entries()) {
    if (bindingIds.has(binding.id)) ctx.addIssue({ code: 'custom', message: `Duplicate binding id: ${binding.id}`, path: ['bindings', i, 'id'] });
    if (!serverIds.has(binding.serverId) && !isMcpPluginItemIdV1(binding.serverId)) ctx.addIssue({ code: 'custom', message: `Server not found: ${binding.serverId}`, path: ['bindings', i, 'serverId'] });
    const key = JSON.stringify([binding.serverId, reachRuleKeyV1(binding)]);
    if (ruleKeys.has(key)) ctx.addIssue({ code: 'custom', message: 'Duplicate reach rule', path: ['bindings', i] });
    ruleKeys.add(key);
    bindingIds.add(binding.id);
  }
}

export const McpServersSettingsV1Schema = lazyZodSchema(() => z
  .preprocess(
    (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw;
    },
    z
      .object({
        v: z.literal(1).default(1),
        strictMode: z.boolean().default(false),
        servers: z.array(McpServerCatalogEntryV1Schema).default([]),
        bindings: z.array(McpServerRuleV1Schema).default([]),
        pluginServers: McpServerPluginSettingsMapV1Schema.optional(),
      })
      .superRefine(refineMcpServerCatalogV1),
  ));

export type McpServersSettingsV1 = z.infer<typeof McpServersSettingsV1Schema>;
