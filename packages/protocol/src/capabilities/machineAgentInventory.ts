import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import type { CapabilitiesDetectRequest } from './index.js';
import type { PluginProjectionV2 } from '../daemon/contributionRegistryProjection.js';
import { AcpBackendDefinitionV1Schema, AcpBackendLaunchV1Schema, type AcpBackendDefinitionV1 } from '../acp/catalog/settingsV1.js';
import type { AcpCatalogSnapshotV1 } from '../acp/catalog/catalogRowsV1.js';
import { AcpPlatformFitV1Schema } from '../acp/catalog/registry/acpPlatformFitV1.js';

/** Caller-owned executable facts only. Inventory never carries environment or secret material. */
export const MachineAcpInventoryDefinitionSchema = lazyZodSchema(() => z.object({
  definitionId: AcpBackendDefinitionV1Schema.shape.id,
  title: z.string().min(1),
  launch: AcpBackendLaunchV1Schema.refine(launch => launch.kind !== 'command' && !('envByPlatform' in launch)),
}).strict());
export type MachineAcpInventoryDefinition = z.output<typeof MachineAcpInventoryDefinitionSchema>;
export const MachineAcpInventoryRequestSchema = lazyZodSchema(() => z.object({
  definitions: z.array(MachineAcpInventoryDefinitionSchema).refine(definitions => new Set(definitions.map(definition => definition.definitionId)).size === definitions.length),
}).strict());
const DefinitionCatalogUnavailableSchema = lazyZodSchema(() => z.object({ status: z.literal('unavailable'), reason: z.string().min(1) }).strict());
type DefinitionInventoryInput = Readonly<{
  definitions?: readonly MachineAcpInventoryDefinition[];
  definitionCatalog?: z.output<typeof DefinitionCatalogUnavailableSchema>;
}>;

export function buildMachineAgentInventoryKey(target: Readonly<{ agentId: string; definitionId?: string }>): string {
  return target.definitionId === undefined ? target.agentId : JSON.stringify([target.agentId, target.definitionId]);
}

export function projectAcpCatalogForMachineInventory(catalog: AcpCatalogSnapshotV1 | undefined,
  retainedDefinitions: readonly AcpBackendDefinitionV1[] = [],
): DefinitionInventoryInput {
  const observed = catalog?.status === 'ready' || catalog?.status === 'partial' ? catalog.record.definitions : retainedDefinitions;
  const definitions = observed.filter(definition => definition.launch.kind !== 'command').map(definition => {
    const launch = definition.launch.kind === 'archive'
      ? (({ envByPlatform: _environment, ...facts }) => facts)(definition.launch) : definition.launch;
    return MachineAcpInventoryDefinitionSchema.parse({ definitionId: definition.id, title: definition.title, launch });
  });
  return { definitions, ...(catalog?.status === 'ready' ? {} : { definitionCatalog: { status: 'unavailable' as const,
    reason: catalog?.status === 'partial' || catalog?.status === 'unavailable' ? catalog.reason : 'catalog-not-ready' } }) };
}

const MachineAgentFactsSchema = lazyZodSchema(() => z.object({
  installed: z.boolean(),
  managed: z.boolean().optional(),
  fit: AcpPlatformFitV1Schema.optional(),
  version: z.string().nullable(),
  latestVersion: z.string().nullable(),
  update: z.object({ supported: z.boolean(), command: z.string().nullable() }).strict(),
  signIn: z.object({
    status: z.enum(['signedIn', 'signedOut', 'unknown']),
    accountLabel: z.string().optional(),
    loginSupport: z.enum(['login_terminal', 'status_only', 'manual_only', 'unsupported']),
  }).strict(),
  platform: z.discriminatedUnion('supported', [
    z.object({ supported: z.literal(true) }).strict(),
    z.object({ supported: z.literal(false), reason: z.enum(['os', 'arch']) }).strict(),
  ]),
  install: z.object({
    available: z.boolean(),
    mode: z.enum(['managed', 'vendor_recipe', 'manual', 'none']),
    sizeBytes: z.number().nonnegative().nullable(),
    guideUrl: z.string().nullable(),
  }).strict(),
  dependencies: z.array(z.object({
    key: z.string().min(1), installed: z.boolean(), version: z.string().nullable(),
  }).strict()),
}));

/** Daemon facts, before connected-account or presentation-state composition. */
export const MachineAgentInventoryItemSchema = lazyZodSchema(() => MachineAgentFactsSchema.extend({
  agentId: z.string().min(1), definitionId: AcpBackendDefinitionV1Schema.shape.id.optional(), title: z.string().min(1),
}).strict());
export type MachineAgentInventoryItem = z.output<typeof MachineAgentInventoryItemSchema>;

/** A failed probe carries no installation or readiness facts. */
export const MachineAgentInventoryUnavailableSchema = lazyZodSchema(() => z.object({
  agentId: z.string().min(1),
  definitionId: AcpBackendDefinitionV1Schema.shape.id.optional(),
  reason: z.enum(['missing_result', 'probe_failed', 'invalid_facts']),
  errorCode: z.string().optional(),
}).strict());
export type MachineAgentInventoryUnavailable = z.output<typeof MachineAgentInventoryUnavailableSchema>;

export const MachinesAgentsListInputSchema = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1),
  serverId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  definitionId: AcpBackendDefinitionV1Schema.shape.id.optional(),
  refresh: z.boolean().optional(),
}).strict());
export type MachinesAgentsListInput = z.output<typeof MachinesAgentsListInputSchema>;

export const MachinesAgentsListOutputSchema = lazyZodSchema(() => z.object({
  items: z.array(MachineAgentInventoryItemSchema),
  unavailable: z.array(MachineAgentInventoryUnavailableSchema).optional(),
  definitionCatalog: DefinitionCatalogUnavailableSchema.optional(),
}).strict());
export type MachinesAgentsListOutput = z.output<typeof MachinesAgentsListOutputSchema>;

export type MachineAgentInventoryDescriptor = Readonly<{ agentId: string; definitionId?: string; title: string }>;

/** The target machine's projected registry owns the session-capable roster. */
export function buildMachineAgentInventoryDescriptors(
  projection: Pick<PluginProjectionV2, 'agentsById'>,
  definitions: readonly Pick<MachineAcpInventoryDefinition, 'definitionId' | 'title'>[] = [],
): readonly MachineAgentInventoryDescriptor[] {
  return [...Object.entries(projection.agentsById)
    .filter(([, agent]) => Boolean(agent.capabilities?.sessions))
    .map(([agentId, agent]) => ({ agentId, title: agent.title?.trim() || agentId })),
    ...definitions.map(definition => ({ agentId: 'custom-acp', definitionId: definition.definitionId, title: definition.title }))];
}

/** Inventory readers share non-interactive facts; launch admission needs no vendor update lookup. */
export function buildMachineAgentsDetectRequest(input: Readonly<{
  agents: readonly MachineAgentInventoryDescriptor[];
  refresh?: boolean;
  includeLatestVersion?: boolean;
}> & DefinitionInventoryInput): CapabilitiesDetectRequest {
  return {
    requests: [...input.agents.filter(agent => agent.definitionId === undefined).map(({ agentId }) => ({
      id: `cli.${agentId}`,
      params: { includeLoginStatus: true, ...(input.includeLatestVersion === false ? {} : { includeLatestVersion: true }) },
    }) as const), ...(input.definitions && !input.definitionCatalog
      ? [{ id: 'tool.acpAgentInventory' as const, params: MachineAcpInventoryRequestSchema.parse({ definitions: input.definitions }) }] : [])],
    ...(input.refresh === true ? { bypassCache: true } : {}),
  };
}

export class MachineAgentInventoryUnavailableError extends Error {
  readonly code = 'machine_agent_inventory_unavailable' as const;
  constructor(readonly agentId: string) {
    super(`Agent inventory is unavailable for ${agentId}`);
    this.name = 'MachineAgentInventoryUnavailableError';
  }
}

/** Strip legacy probe metadata; readiness remains exclusively daemon-owned. */
export function projectMachineAgentsDetectResponse(input: Readonly<{
  agents: readonly MachineAgentInventoryDescriptor[];
  response: unknown;
}> & DefinitionInventoryInput): MachinesAgentsListOutput {
  if (!input.response || typeof input.response !== 'object' || Array.isArray(input.response)
    || Reflect.get(input.response, 'protocolVersion') !== 1) {
    throw new MachineAgentInventoryUnavailableError(input.agents[0]?.agentId ?? 'unknown');
  }
  const results: unknown = Reflect.get(input.response, 'results');
  if (!results || typeof results !== 'object' || Array.isArray(results)) {
    throw new MachineAgentInventoryUnavailableError(input.agents[0]?.agentId ?? 'unknown');
  }
  const items: MachineAgentInventoryItem[] = [];
  const unavailable: MachineAgentInventoryUnavailable[] = [];
  for (const { agentId, title } of input.agents.filter(agent => agent.definitionId === undefined)) {
    const result: unknown = Reflect.get(results, `cli.${agentId}`);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      unavailable.push({ agentId, reason: 'missing_result' });
      continue;
    }
    if (Reflect.get(result, 'ok') !== true) {
      const error: unknown = Reflect.get(result, 'error');
      const errorCode: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      unavailable.push({ agentId, reason: 'probe_failed', ...(typeof errorCode === 'string' ? { errorCode } : {}) });
      continue;
    }
    const data: unknown = Reflect.get(result, 'data');
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      unavailable.push({ agentId, reason: 'invalid_facts' });
      continue;
    }
    const parsed = MachineAgentFactsSchema.safeParse({
      ...data, version: Reflect.get(data, 'version') ?? null, latestVersion: Reflect.get(data, 'latestVersion') ?? null,
    });
    if (!parsed.success) {
      unavailable.push({ agentId, reason: 'invalid_facts' });
      continue;
    }
    items.push({ agentId, title, ...parsed.data });
  }
  if (input.definitions) {
    const result: unknown = Reflect.get(results, 'tool.acpAgentInventory');
    const response = result && typeof result === 'object' && Reflect.get(result, 'ok') === true
      ? MachinesAgentsListOutputSchema.safeParse(Reflect.get(result, 'data')) : null;
    const expected = new Map(input.definitions.map(definition => [definition.definitionId, definition]));
    const valid = response?.success && !response.data.unavailable && !response.data.definitionCatalog
      && response.data.items.length === expected.size
      && new Set(response.data.items.map(item => item.definitionId)).size === expected.size
      && response.data.items.every(item => item.agentId === 'custom-acp' && item.definitionId !== undefined
        && item.title === expected.get(item.definitionId)?.title && item.managed !== undefined && item.fit !== undefined);
    if (!input.definitionCatalog && valid && response.success) items.push(...response.data.items);
    else for (const definition of input.definitions) {
      const error = result && typeof result === 'object' ? Reflect.get(result, 'error') : undefined;
      const errorCode = input.definitionCatalog?.reason
        ?? (error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined);
      unavailable.push({ agentId: 'custom-acp', definitionId: definition.definitionId,
        reason: input.definitionCatalog || result && typeof result === 'object' && Reflect.get(result, 'ok') === false
          ? 'probe_failed' : result === undefined ? 'missing_result' : 'invalid_facts',
        ...(typeof errorCode === 'string' ? { errorCode } : {}) });
    }
  }
  return { items, ...(unavailable.length > 0 ? { unavailable } : {}), ...(input.definitionCatalog ? { definitionCatalog: input.definitionCatalog } : {}) };
}
