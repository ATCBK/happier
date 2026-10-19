import type { MessageMeta } from "@happier-dev/session-core/messages";
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

export const VOICE_TRANSCRIPT_NOTE_META_KIND = 'voice_note.v1';

const nonBlank = z.string().check(z.refine((value) => value.trim().length > 0 && value === value.trim()));
const continuationSchema = z.strictObject({
    v: z.literal(1),
    deviceId: nonBlank,
    deviceDisplayName: z.optional(z.nullable(nonBlank)),
    conversation: z.strictObject({ serverId: nonBlank, sessionId: nonBlank }),
});
export const VoiceTranscriptNotePayloadSchema = z.strictObject({ v: z.literal(1), continuation: z.optional(continuationSchema) });
export type VoiceContinuationProvenance = z.infer<typeof continuationSchema>;

export function buildVoiceTranscriptNoteMeta(input?: Readonly<{ continuation: VoiceContinuationProvenance }>): MessageMeta {
    return {
        happier: {
            kind: VOICE_TRANSCRIPT_NOTE_META_KIND,
            payload: VoiceTranscriptNotePayloadSchema.parse({ v: 1, ...(input ? { continuation: input.continuation } : {}) }),
        },
    };
}

/** Missing predecessor notes remain ordinary notes; unknown or malformed data never controls capture. */
export function readVoiceContinuationProvenance(meta: unknown): VoiceContinuationProvenance | null {
    if (!hasVoiceTranscriptNoteMeta(meta)) return null;
    const happier = (meta as Readonly<{ happier: Readonly<{ payload?: unknown }> }>).happier;
    const result = createStoredReadSchema(VoiceTranscriptNotePayloadSchema).safeParse(happier.payload);
    return result.success ? result.data.continuation ?? null : null;
}

export function hasVoiceTranscriptNoteMeta(meta: unknown): boolean {
    const happier = meta && typeof meta === 'object'
        ? (meta as { happier?: { kind?: unknown } }).happier
        : null;
    return happier?.kind === VOICE_TRANSCRIPT_NOTE_META_KIND;
}
