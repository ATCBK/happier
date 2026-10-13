import { z } from 'zod';
import type { Metadata } from '@/api/types';
import { SessionCreationOutcomeSchema } from '@/session/shared/spawnSessionContract';
import { SessionMetadataPublisherPreconditionV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';

// Keep the established report's permissive API metadata bag. Its correlation
// owner validates the process and placement fields it consumes.
export const SessionStartedSuccessReportSchema = z.object({
    sessionId: z.string(),
    metadata: z.custom<Metadata>(),
    sessionCreationOutcome: SessionCreationOutcomeSchema.optional(),
    persistedTakeoverAdmission: z.object({
        mode: z.enum(['persisted', 'external_linked']),
        operationId: z.string().trim().min(1).max(256),
        attemptId: z.string().trim().min(1).max(256),
        phase: z.enum(['admit', 'runtime_bound']).optional(),
        publisherPrecondition: SessionMetadataPublisherPreconditionV1Schema,
    }).strict().optional(),
}).strict();
