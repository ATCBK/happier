import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

const MinuteOfDaySchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(24 * 60 - 1)));
const WeekdaySchema = lazyZodSchema(() => z.number().check(z.int(), z.minimum(0), z.maximum(6)));

export const SessionReminderPresetRuleSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('relative_day'), daysAhead: z.number().check(z.int(), z.minimum(1)), minuteOfDay: MinuteOfDaySchema }),
  z.object({ kind: z.literal('next_weekday'), weekday: WeekdaySchema, minuteOfDay: MinuteOfDaySchema }),
  z.object({ kind: z.literal('next_calendar_weekday'), weekday: WeekdaySchema, weeksAhead: z.optional(z.number().check(z.int(), z.minimum(1))), minuteOfDay: MinuteOfDaySchema }),
]));

export const SessionReminderPresetV1Schema = lazyZodSchema(() => z.object({
  rule: SessionReminderPresetRuleSchema,
  label: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const SessionReminderPresetsV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = SessionReminderPresetV1Schema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}), z.array(SessionReminderPresetV1Schema)));

export type SessionReminderPresetRule = z.infer<typeof SessionReminderPresetRuleSchema>;
export type SessionReminderPresetV1 = z.infer<typeof SessionReminderPresetV1Schema>;
