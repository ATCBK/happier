import { z } from 'zod/mini';

import { createTranscriptRawRecordV1Schema, type TranscriptRawRecordV1WithMeta } from '@happier-dev/protocol/sessions/messages/transcriptRawRecordV1';
import type { TranscriptRawAgentContentV1, TranscriptRawAgentEventV1, TranscriptRawRecordV1, TranscriptRawUsageDataV1 } from '@happier-dev/protocol';

import { MessageMetaSchema, type MessageMeta } from "../messages/messageMetaTypes.js";

export const rawRecordSchema: z.ZodMiniType<TranscriptRawRecordV1WithMeta<MessageMeta>> = createTranscriptRawRecordV1Schema(z, {
    metaSchema: MessageMetaSchema,
});

export type RawRecord = TranscriptRawRecordV1;
export type RawAgentContent = TranscriptRawAgentContentV1;
export type AgentEvent = TranscriptRawAgentEventV1;
export type UsageData = TranscriptRawUsageDataV1;

export const RawRecordSchema: typeof rawRecordSchema = rawRecordSchema;
