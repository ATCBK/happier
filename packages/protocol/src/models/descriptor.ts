import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { CapabilitySupportSchema } from '../providers/capabilities/v1.js';
import { ProviderModelIdSchema } from '../providers/ids.js';

export const AgentModelOptionValueIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
export type AgentModelOptionValueId = string;

/**
 * @experimental
 *
 * Declared by a boolean model option whose ON state overrides other options on the same
 * model: while it is effectively on, `optionIds` are not user-controllable, and — when
 * `forcedValue` is given — the agent actually runs those options at that value regardless
 * of what the user stored. The producing agent owns this fact because only it knows what
 * its own toggle does (e.g. Claude's `ultracode` runs `reasoning_effort` at `xhigh`).
 */
export type AgentModelOptionOverrideRule = Readonly<{
  optionIds: readonly string[];
  forcedValue?: AgentModelOptionValueId;
}>;

export type AgentModelOption = Readonly<{
  id: string;
  name: string;
  description?: string;
  type: string;
  currentValue: AgentModelOptionValueId;
  options?: readonly Readonly<{
    value: AgentModelOptionValueId;
    name: string;
    description?: string;
  }>[];
  /** @experimental See {@link AgentModelOptionOverrideRule}. Boolean options only. */
  overridesWhenOn?: AgentModelOptionOverrideRule;
}>;

/**
 * The producer contract for {@link AgentModelOptionOverrideRule} — the WRITE side. It is
 * `.strict()` because an agent must not author an undeclared field: the owner-metadata envelopes
 * are strict too, and would reject the entire session metadata rather than strip it.
 */
export const AgentModelOptionOverrideRuleSchema = z.strictObject({
  optionIds: z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))).check(z.minLength(1), z.maxLength(32)),
  forcedValue: z.optional(AgentModelOptionValueIdSchema),
}) satisfies z.ZodMiniType<AgentModelOptionOverrideRule>;

/**
 * The READ side of the same rule, and the single owner of the unknown-key policy for reading one
 * back out of persisted metadata.
 *
 * Every reader of an already-persisted rule uses this — the UI's session-control parse and the
 * CLI's fork/spawn catalog inheritance — because a reader that rejects on an unrecognized nested
 * key makes a NEWER producer's added field destroy the rule (and, inside a strict parent, the whole
 * parse) in an OLDER client. Readers degrade to the fields they know instead. Bounds are shared
 * with the strict schema above, so a reader can never accept a rule the producer contract forbids.
 */
export const AgentModelOptionOverrideRuleReadSchema = z.object(
  AgentModelOptionOverrideRuleSchema.shape,
) satisfies z.ZodMiniType<AgentModelOptionOverrideRule>;

export const AgentModelOptionSchema = z.strictObject({
  id: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  description: z.optional(z.string().check(z.maxLength(1024))),
  type: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  currentValue: AgentModelOptionValueIdSchema,
  options: z.optional(z.array(z.strictObject({
    value: AgentModelOptionValueIdSchema,
    name: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    description: z.optional(z.string().check(z.maxLength(1024))),
  })).check(z.maxLength(128))),
  overridesWhenOn: z.optional(AgentModelOptionOverrideRuleSchema),
}) satisfies z.ZodMiniType<AgentModelOption>;

export type ProviderModelDescriptorV1 = Readonly<{
  id: string;
  name: string;
  /** Catalog-owned relative cost class; absence never implies a low-cost model. */
  costTier?: 'low' | 'standard' | 'premium';
  /** Provider/source-owned request spellings for this exact canonical model. */
  aliases?: readonly string[];
  description?: string;
  contextWindowTokens?: number;
  extendedContextModelId?: string;
  modelOptions?: readonly AgentModelOption[];
  capabilities?: Readonly<{
    toolRoundTrips?: z.infer<typeof CapabilitySupportSchema>;
    reasoningControls?: z.infer<typeof CapabilitySupportSchema>;
    structuredOutput?: z.infer<typeof CapabilitySupportSchema>;
  }>;
}>;

export const ProviderModelDescriptorV1Schema = z.strictObject({
  id: ProviderModelIdSchema,
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  costTier: z.optional(z.enum(['low', 'standard', 'premium'])),
  aliases: z.optional(z.array(ProviderModelIdSchema).check(z.maxLength(64))),
  description: z.optional(z.string().check(z.maxLength(1024))),
  contextWindowTokens: z.optional(z.number().check(z.int(), z.positive(), z.maximum(100_000_000))),
  extendedContextModelId: z.optional(ProviderModelIdSchema),
  modelOptions: z.optional(z.array(AgentModelOptionSchema).check(z.maxLength(64))),
  capabilities: z.optional(z.strictObject({
    toolRoundTrips: z.optional(CapabilitySupportSchema),
    reasoningControls: z.optional(CapabilitySupportSchema),
    structuredOutput: z.optional(CapabilitySupportSchema),
  })),
}).check(z.superRefine((value, context) => {
  if (value.aliases) {
    if (new Set(value.aliases).size !== value.aliases.length) {
      context.addIssue({ code: 'custom', path: ['aliases'], message: 'Model aliases must be unique' });
    }
    if (value.aliases.includes(value.id)) {
      context.addIssue({ code: 'custom', path: ['aliases'], message: 'A canonical model id cannot alias itself' });
    }
  }
})) satisfies z.ZodMiniType<ProviderModelDescriptorV1>;

export type AgentModelDescriptor = ProviderModelDescriptorV1;

/** Display-only lookup over contributed facts; never rewrites a request id or infers an alias. */
export function resolveModelDisplayName(
  model: Readonly<{ id: string; name?: string }>,
  catalog: readonly Pick<ProviderModelDescriptorV1, 'id' | 'name' | 'aliases'>[],
): string {
  const supplied = model.name?.trim();
  if (supplied && supplied !== model.id) return supplied;
  let name: string | undefined;
  for (const candidate of catalog) {
    if (candidate.id !== model.id && !candidate.aliases?.includes(model.id)) continue;
    if (name !== undefined && name !== candidate.name) return model.id;
    name = candidate.name;
  }
  return name ?? model.id;
}

/** Catalog membership and the exact Agent's declared JSON contract establish support.
 * A freeform id never borrows that contract; explicit model evidence always wins.
 * This describes JSON publication with host validation/repair, not native schema enforcement.
 */
export function resolveModelStructuredOutputSupport(params: Readonly<{
  model?: Pick<ProviderModelDescriptorV1, 'capabilities'> | null;
  catalogModel: boolean;
  agentFormats?: readonly string[] | null;
}>): z.infer<typeof CapabilitySupportSchema> {
  const explicit = params.model?.capabilities?.structuredOutput;
  if (explicit !== undefined) return explicit;
  return params.catalogModel && params.agentFormats?.includes('json') === true ? 'supported' : 'unknown';
}
