import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { UsageCoachDetectorIdSchema } from '../../usage/coach/coachDetectorIds.js';

const evidenceKey = lazyZodSchema(() => z.string().trim().min(1));
export const UsageCoachSuppressionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('dismissed'), evidenceKey }).strict(),
    z.object({ kind: z.literal('snoozed'), evidenceKey, untilMs: z.number().int().nonnegative().safe() }).strict(),
]));
export const UsageCoachPreferencesV1Schema = lazyZodSchema(() => z.object({
    v: z.literal(1).default(1),
    suppressions: z.array(UsageCoachSuppressionV1Schema).default([]),
    disabledChecks: z.array(UsageCoachDetectorIdSchema).default([]),
    modelSuggestion: z.enum(['off', 'suggest_with_estimates', 'complete_only']).default('suggest_with_estimates'),
}).strict().superRefine((preferences, context) => {
    if (new Set(preferences.disabledChecks).size !== preferences.disabledChecks.length) {
        context.addIssue({ code: 'custom', path: ['disabledChecks'], message: 'Each check has one enabled state' });
    }
    const seen = new Set<string>();
    preferences.suppressions.forEach((suppression, index) => {
        if (seen.has(suppression.evidenceKey)) context.addIssue({ code: 'custom', path: ['suppressions', index, 'evidenceKey'],
            message: 'Each finding evidence has one suppression state' });
        seen.add(suppression.evidenceKey);
    });
}));
export type UsageCoachPreferencesV1 = z.infer<typeof UsageCoachPreferencesV1Schema>;
export const DEFAULT_USAGE_COACH_PREFERENCES_V1 = UsageCoachPreferencesV1Schema.parse({});
