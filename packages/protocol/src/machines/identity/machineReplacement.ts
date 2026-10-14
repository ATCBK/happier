import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

export const MachineReplacementReasonSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(128), z.regex(/^[a-z][a-z0-9_:-]*$/u)));

export type MachineReplacementReason = z.infer<typeof MachineReplacementReasonSchema>;

export const MachineReplacementFieldsSchema = lazyZodSchema(() => z.object({
    replacesMachineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    replacementReason: z.optional(MachineReplacementReasonSchema),
}));

export type MachineReplacementFields = z.infer<typeof MachineReplacementFieldsSchema>;

export type MachineReplacementRegistrationIntent = Readonly<{
    replacesMachineId: string;
    replacementReason: MachineReplacementReason;
}>;

export function readMachineReplacementRegistrationIntent(
    input: unknown,
): MachineReplacementRegistrationIntent | null {
    const parsed = MachineReplacementFieldsSchema.safeParse(input);
    if (!parsed.success) return null;
    const replacesMachineId = parsed.data.replacesMachineId?.trim();
    const replacementReason = parsed.data.replacementReason?.trim();
    if (!replacesMachineId || !replacementReason) return null;
    return { replacesMachineId, replacementReason };
}
