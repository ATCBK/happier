import type { z } from 'zod/mini';

import { AutomationTemplateEncryptionMaterialUnavailableError } from './automationTemplateAvailability';

/** Schema-specific recipe callers share the Account envelope and currentness owner. */
export async function openAutomationRecipePayloadForAuthoring<T>(params: Readonly<{
    envelope: Readonly<{ t: 'plain'; v: unknown }> | Readonly<{ t: 'encrypted'; c: string }>;
    schema: z.ZodMiniType<T>;
    decryptRaw?: (ciphertext: string) => Promise<unknown | null>;
    isCurrent?: () => boolean;
}>): Promise<T> {
    const opened = params.envelope.t === 'plain'
        ? params.envelope.v
        : params.decryptRaw ? await params.decryptRaw(params.envelope.c) : null;
    if (params.isCurrent && !params.isCurrent()) throw new Error('Automation authoring authority changed');
    const parsed = params.schema.safeParse(opened);
    if (!parsed.success) throw new AutomationTemplateEncryptionMaterialUnavailableError();
    return parsed.data;
}
