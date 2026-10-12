import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ReachRuleDraftV1Schema } from '../../reach/reachRuleV1.js';
import { McpServerCatalogMutationResponseV1Schema } from '../../mcp/servers/catalogSchemasV1.js';
import { ReachRulesChangeV1Schema } from '../../reach/reachRulesChangeV1.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { ActionCliBindContext } from '../actionCliProjection.js';
import type { ActionId } from '../actionIds.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export { CAPABILITY_RULES_ACTION_IDS_V1 } from '../capabilityRulesActionIdsV1.js';
const identity = lazyZodSchema(() => z.string().trim().min(1));
export const McpRulesSetInputV1Schema = lazyZodSchema(() => z.object({
  items: z.array(z.union([z.object({ serverId: identity }).strict(), z.object({ name: identity }).strict()])).min(1),
  change: ReachRulesChangeV1Schema,
}).strict());
export const McpRulesSetItemResultV1Schema = lazyZodSchema(() => McpServerCatalogMutationResponseV1Schema.options[0].shape.items.unwrap().element);
export const McpRulesSetOutputV1Schema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true), items: z.array(McpRulesSetItemResultV1Schema),
    revision: z.number().int().nonnegative() }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['not_found', 'conflict', 'catalog_unavailable', 'replace_needs_one_item']) }).strict(),
]));
const rulesCliInput = lazyZodSchema(() => z.object({
  names: z.array(identity).optional(), itemIds: z.array(identity).optional(),
  everywhere: z.boolean().optional(), machine: identity.optional(), project: identity.optional(), folder: identity.optional(),
  agent: identity.optional(), rules: z.array(ReachRuleDraftV1Schema).optional(),
}).strict());

/** Friendly argv reshaping only; name lookup and mutation belong to the catalog Action. */
function bindRulesCliInput(value: unknown, context: ActionCliBindContext, idField: 'serverId' | 'skillId'): unknown {
  const input = rulesCliInput.parse(value);
  const items = [...(input.names ?? []).map(name => ({ name })), ...(input.itemIds ?? []).map(id => ({ [idField]: id }))];
  const leaf = context.commandPath?.at(-1);
  if (leaf === 'rules') {
    if (input.rules === undefined) throw new Error('Supply the replacement rules with --rules-json.');
    return { items, change: { kind: 'replace', rules: input.rules } };
  }
  const state = leaf === 'bind' ? 'on' : leaf === 'unbind' ? 'inherit' : leaf;
  if (state !== 'on' && state !== 'off' && state !== 'inherit') throw new Error('Choose on, off or inherit.');
  if (input.rules !== undefined) throw new Error('Replacement rules use the rules command.');
  const places = Number(input.everywhere === true) + Number(input.project !== undefined)
    + Number(input.machine !== undefined && input.folder === undefined) + Number(input.folder !== undefined);
  if (places > 1 || (input.folder !== undefined && input.machine === undefined)) throw new Error('Choose one place; --folder requires --machine.');
  const place = input.folder !== undefined ? { t: 'workspace', machineId: input.machine, workspaceRoot: input.folder }
    : input.project !== undefined ? { t: 'project', projectKey: input.project }
      : input.machine !== undefined ? { t: 'machine', machineId: input.machine } : { t: 'allMachines' };
  return { items, change: { kind: 'write', write: { place, state, ...(input.agent ? { agentId: input.agent } : {}) } } };
}

/** Both catalogs declare one rules operation and their own identity/receipt schemas. */
export function createCapabilityRulesActionSpecV1<TId extends ActionId, TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(input: Readonly<{
  id: TId; title: string; itemKind: 'mcp' | 'skills'; idField: 'serverId' | 'skillId';
  inputSchema: TInput; outputSchema: TOutput;
}>): PreNormalizedActionSpec & Readonly<{ id: TId; inputSchema: TInput; outputSchema: TOutput }> {
  const commands = [
    { path: [input.itemKind, 'rules', 'set'], visibility: 'canonical' as const },
    ...(['on', 'off', 'inherit', 'rules'] as const).map(leaf => ({
      path: [input.itemKind, leaf], variadicPositional: 'names', visibility: 'canonical' as const,
    })),
    ...(input.itemKind === 'mcp' ? (['bind', 'unbind'] as const).map(leaf => ({
      path: ['mcp', 'servers', leaf], variadicPositional: 'names', visibility: 'alias' as const,
    })) : []),
  ];
  const projectObservation = (raw: unknown) => {
    const value = readRecord(raw);
    return { ...(typeof value.ok === 'boolean' ? { ok: value.ok } : {}),
      ...(typeof value.revision === 'number' ? { revision: value.revision } : {}),
      ...(Array.isArray(value.items) ? { itemIds: value.items.map(item => readRecord(item)[input.idField]).filter(id => typeof id === 'string') } : {}) };
  };
  return {
    id: input.id, title: input.title, safety: 'danger', approval: { result: 'required' },
    sideEffectClass: 'write', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    bindings: { rpcMethod: input.id, mcpToolName: input.id.replaceAll('.', '_') },
    inputSchema: input.inputSchema, outputSchema: input.outputSchema,
    inputHints: { fields: [{ path: 'items', title: 'Items', widget: 'json', required: true },
      { path: 'change', title: 'Rules change', widget: 'json', required: true }] },
    projectObservationInput: projectObservation, projectObservationOutput: projectObservation,
    cli: { acceptsServerId: true, commands, inputSchema: rulesCliInput,
      bindInput: (value, context) => bindRulesCliInput(value, context, input.idField),
      flagAliases: [{ path: 'everywhere', aliases: ['--all-machines'] }, ...(input.itemKind === 'mcp' ? [{ path: 'names', aliases: ['--mcp-server'] }] : []),
        { path: 'rules', aliases: ['--rules-json'] }],
      inputHints: { fields: [{ path: 'rules', title: 'Replacement rules', widget: 'json' }] } },
  };
}
export const CAPABILITY_RULES_ACTION_SPECS_V1 = [createCapabilityRulesActionSpecV1({
  id: 'mcp.rules.set', title: 'Change where MCP servers are on', itemKind: 'mcp', idField: 'serverId',
  inputSchema: McpRulesSetInputV1Schema, outputSchema: McpRulesSetOutputV1Schema,
})] as const;
