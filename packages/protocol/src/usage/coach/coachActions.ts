import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { UsageQuerySchema } from '../../inputs/usageQuery.js';
import { SettingsDeclarationMutationReversalV1Schema, SettingsDeclarationValueV1Schema } from '../../actions/settingsDeclarationActionFamily.js';
import { SessionModelMutationReversalV1Schema } from '../../sessions/control/modelTransitionV1.js';
import { McpRulesSetItemResultV1Schema } from '../../actions/specs/capabilityRules.js';
import { UsageCoachRemedySchema } from './coachRemedy.js';

const identity = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const reference = lazyZodSchema(() => z.strictObject({ query: UsageQuerySchema, evidenceKey: identity }));
/** Stateless owner results; each owner validates its own atomic restore contract. */
export const UsageCoachReversalSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('setting'), anchor: identity, appliedValue: SettingsDeclarationValueV1Schema,
        owner: SettingsDeclarationMutationReversalV1Schema }),
    z.strictObject({ kind: z.literal('model'), sessionId: identity, owner: SessionModelMutationReversalV1Schema }),
    z.strictObject({ kind: z.literal('mcp_binding'), owner: McpRulesSetItemResultV1Schema,
        appliedRevision: z.number().check(z.int(), z.nonnegative(), z.int()) }),
]));
export type UsageCoachReversal = z.infer<typeof UsageCoachReversalSchema>;
export const UsageCoachApplyInputSchema = reference;
export const UsageCoachUndoInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(reference, { reversal: UsageCoachReversalSchema })));
export const UsageCoachDismissInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(reference, { dismissed: z.boolean() })));
export const UsageCoachSnoozeInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(reference, { untilMs: z.nullable(z.number().check(z.int(), z.nonnegative(), z.int())) })));
export const UsageCoachApplyResultSchema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('applied'), evidenceKey: identity, remedy: UsageCoachRemedySchema,
    reversal: z.optional(UsageCoachReversalSchema),
    spawnedSessionId: z.optional(identity),
    reversalUnavailableReason: z.optional(z.enum(['not_reversible', 'no_change'])),
}));
export const UsageCoachUndoResultSchema = lazyZodSchema(() => z.strictObject({ kind: z.literal('undone'), evidenceKey: identity }));
export const UsageCoachPreferenceResultSchema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('preference_updated'), evidenceKey: identity,
    dismissed: z.optional(z.boolean()), untilMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative(), z.int()))),
}));
