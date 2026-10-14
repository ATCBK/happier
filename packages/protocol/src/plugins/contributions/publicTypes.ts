import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import {
  defineProtocolObject,
  defineProtocolUnion,
} from '../actions/protocolComposableSchema.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  type PluginJsonSchemaV2,
  type PluginJsonValueV2,
} from './jsonSchema.js';

export {
  PluginJsonSchemaV2Schema,
  PluginJsonValueV2Schema,
  type PluginJsonSchemaV2,
  type PluginJsonValueV2,
} from './jsonSchema.js';

export const PluginLocalizedStringV2Schema = lazyZodSchema(() => z.union([
  z.string().check(z.trim(), z.minLength(1)),
  z.strictObject({ key: z.string().check(z.trim(), z.minLength(1)), fallback: z.string().check(z.trim(), z.minLength(1)) }),
]));
export type PluginLocalizedStringV2 = z.infer<typeof PluginLocalizedStringV2Schema>;

// Markdown indentation and trailing spaces carry formatting semantics. Keep the
// existing nonblank admission rule without transforming the authored content.
const PluginMarkdownTextV2Schema = lazyZodSchema(() => z.string().check(z.refine((value) => value.trim().length > 0)));
export const PluginLocalizedMarkdownV2Schema = lazyZodSchema(() => z.union([
  PluginMarkdownTextV2Schema,
  z.strictObject({ key: z.string().check(z.trim(), z.minLength(1)), fallback: PluginMarkdownTextV2Schema }),
]));

export const PluginContributionReferenceV2Schema = defineProtocolUnion([
  PluginContributionLocalIdSchema,
  defineProtocolObject({ pluginId: PluginIdSchema, localId: PluginContributionLocalIdSchema }, { policy: 'closed' }),
]);
export type PluginContributionReferenceV2 = ReturnType<typeof PluginContributionReferenceV2Schema.parse>;


export type PluginPolicyExpressionV2 =
  | { fact: string; operator: string; value: boolean | string }
  | { all: PluginPolicyExpressionV2[] }
  | { any: PluginPolicyExpressionV2[] }
  | { not: PluginPolicyExpressionV2 };
export const PluginPolicyExpressionV2Schema: z.ZodMiniType<PluginPolicyExpressionV2> = z.lazy(() => z.union([
  z.strictObject({ fact: z.enum(['plugin.enabled', 'session.exists', 'project.exists', 'browser.exists']), operator: z.literal('equals'), value: z.boolean() }),
  z.strictObject({ fact: z.literal('host.platform'), operator: z.enum(['equals', 'notEquals']), value: z.enum(['web', 'ios', 'android', 'desktop']) }),
  z.strictObject({ fact: z.literal('host.feature'), operator: z.literal('enabled'), value: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ fact: z.enum(['session.agentId', 'session.state', 'project.id', 'machine.id', 'browser.origin']), operator: z.enum(['equals', 'notEquals']), value: z.string() }),
  z.strictObject({ fact: z.literal('session.capability'), operator: z.literal('contains'), value: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ all: z.array(PluginPolicyExpressionV2Schema) }),
  z.strictObject({ any: z.array(PluginPolicyExpressionV2Schema) }),
  z.strictObject({ not: PluginPolicyExpressionV2Schema }),
]));

export type PluginPolicyFactValueV2 = boolean | string | readonly string[] | undefined;
export type PluginPolicyFactsV2 = Readonly<Record<string, PluginPolicyFactValueV2>>;

/**
 * Pure tri-state evaluation for the canonical availability expression grammar.
 * `undefined` facts remain unknown so each realm can apply its own explicit
 * presentation policy (for example, disabledWhen maps unknown to disabled).
 */
export function evaluatePluginPolicyExpressionV2(
  expression: PluginPolicyExpressionV2,
  facts: PluginPolicyFactsV2,
): boolean | null {
  if ('all' in expression) {
    let unknown = false;
    for (const child of expression.all) {
      const result = evaluatePluginPolicyExpressionV2(child, facts);
      if (result === false) return false;
      if (result === null) unknown = true;
    }
    return unknown ? null : true;
  }
  if ('any' in expression) {
    let unknown = false;
    for (const child of expression.any) {
      const result = evaluatePluginPolicyExpressionV2(child, facts);
      if (result === true) return true;
      if (result === null) unknown = true;
    }
    return unknown ? null : false;
  }
  if ('not' in expression) {
    const result = evaluatePluginPolicyExpressionV2(expression.not, facts);
    return result === null ? null : !result;
  }
  const value = facts[expression.fact];
  if (value === undefined) return null;
  switch (expression.operator) {
    case 'equals':
      return value === expression.value;
    case 'notEquals':
      return value !== expression.value;
    case 'enabled':
      return Array.isArray(value) ? value.includes(expression.value as string) : false;
    case 'contains':
      return Array.isArray(value) ? value.includes(expression.value as string) : false;
  }
  return null;
}

export const PluginAvailabilityDescriptorV2Schema = lazyZodSchema(() => z.union([
  z.strictObject({ when: z.optional(PluginPolicyExpressionV2Schema), disabledWhen: z.optional(z.never()), disabledReason: z.optional(z.never()) }),
  z.strictObject({ when: z.optional(PluginPolicyExpressionV2Schema), disabledWhen: PluginPolicyExpressionV2Schema, disabledReason: PluginLocalizedStringV2Schema }),
]));
export type PluginAvailabilityDescriptorV2 = z.infer<typeof PluginAvailabilityDescriptorV2Schema>;
