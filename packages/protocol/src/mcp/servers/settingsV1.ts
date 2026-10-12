import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { McpRemoteUrlV1Schema } from '../remoteUrlV1.js';
import { ReachPlaceV1Schema } from '../../reach/reachPlaceV1.js';
import { ReachRuleV1Schema } from '../../reach/reachRuleV1.js';
import { reachRuleKeyV1 } from '../../reach/reachRulesChangeV1.js';
import { ValueRefV1Schema } from '../../valueRefs/valueRefV1.js';
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
export const McpServerConfigOverrideFieldsV1Schema = lazyZodSchema(() => z.object({
  stdio: z.object({ command: z.string().min(1).optional(), args: z.array(z.string()).optional() }).strict().optional(),
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
      }).strict()
      .optional(),
    remote: z
      .object({
        url: McpRemoteUrlV1Schema,
        headers: z.record(McpHeaderKeyV1Schema, ValueRefV1Schema),
        auth: z.object({ kind: z.literal('oauth') }).strict().optional(),
      }).strict()
      .optional(),
    env: z.record(McpEnvVarKeyV1Schema, ValueRefV1Schema),
    configOverrides: z.array(McpServerConfigOverrideV1Schema).optional(),
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
export function isMcpPluginItemIdV1(value: string): boolean { return /^plugin:[^/]+\/[^/]+$/.test(value); }
export type McpPluginItemV1 = Readonly<{ itemId: string; name: string; title?: string; config: McpServerCatalogEntryV1; rules: readonly McpServerRuleV1[] }>;

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
      })
      .superRefine(refineMcpServerCatalogV1),
  ));

export type McpServersSettingsV1 = z.infer<typeof McpServersSettingsV1Schema>;
