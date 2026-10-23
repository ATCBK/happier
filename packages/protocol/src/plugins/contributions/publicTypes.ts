import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { PluginPolicyExpressionV2 } from './policyEvaluation.js';
export {
  evaluatePluginPolicyExpressionV2,
  resolveInvocationContributionPolicyFacts,
  evaluateContributionAvailability,
  type PluginPolicyExpressionV2,
  type PluginPolicyFactValueV2,
  type PluginPolicyFactsV2,
  type ContributionAvailabilityOutcome,
  type ContributionAvailabilityDecision,
  type ContributionPolicyFacts,
} from './policyEvaluation.js';

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


export const PluginAvailabilityDescriptorV2Schema = lazyZodSchema(() => z.union([
  z.strictObject({ when: z.optional(PluginPolicyExpressionV2Schema), disabledWhen: z.optional(z.never()), disabledReason: z.optional(z.never()) }),
  z.strictObject({ when: z.optional(PluginPolicyExpressionV2Schema), disabledWhen: PluginPolicyExpressionV2Schema, disabledReason: PluginLocalizedStringV2Schema }),
]));
export type PluginAvailabilityDescriptorV2 = z.infer<typeof PluginAvailabilityDescriptorV2Schema>;
