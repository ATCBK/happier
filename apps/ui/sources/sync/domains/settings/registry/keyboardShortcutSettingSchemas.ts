import { z } from 'zod/mini';

export const KeyboardShortcutRuleSchema = z.object({
    binding: z.string().check(z.trim(), z.minLength(1)),
    platforms: z.optional(z.array(z.enum(['macos', 'ios', 'windows', 'linux', 'android', 'web']))),
    blockedSurfaces: z.optional(z.array(z.enum(['native', 'web']))),
    allowInEditable: z.optional(z.boolean()),
    nativeConsumable: z.optional(z.boolean()),
    conflictScope: z.optional(z.string().check(z.trim(), z.minLength(1))),
});

export const KeyboardShortcutOverridesSchema = z.catch(z.pipe(z.record(z.string().check(z.trim(), z.minLength(1)), z.array(z.unknown())), z.transform((entries) => Object.fromEntries(
        Object.entries(entries)
            .map(([commandId, rawBindings]) => [
                commandId,
                rawBindings
                    .map((entry) => KeyboardShortcutRuleSchema.safeParse(entry))
                    .filter((entry): entry is z.core.util.SafeParseSuccess<z.infer<typeof KeyboardShortcutRuleSchema>> => entry.success)
                    .map((entry) => entry.data),
            ] as const)
            .filter(([, bindings]) => bindings.length > 0),
    ))), {});

export const KeyboardShortcutDisabledCommandIdsSchema = z.catch(z.pipe(z.array(z.unknown()), z.transform((values) => values
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim()))), []);

export function countKeyboardShortcutOverrides(value: unknown): number {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
    return Object.keys(value as Record<string, unknown>).length;
}
