import { z } from 'zod/mini';
import { SessionAuthoringExecutionTargetV2Schema, TemporaryComputerActivationRefV1Schema } from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { isNewSessionDraftLaunchInCustody } from '@/components/sessions/new/modules/newSessionDraftLaunchCustody';
import type { SessionDraftSnapshot } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { getSessionDraftDocumentFieldValue } from '@/sync/ops/sessionDrafts/sessionDraftDocumentFields';

type Draft = Pick<SessionDraftSnapshot, 'localSupplement'> & Readonly<{ document: unknown }>;
const StoredExecutionTargetSchema = createStoredReadSchema(z.nullable(SessionAuthoringExecutionTargetV2Schema));
const StoredActivationReferenceSchema = createStoredReadSchema(z.nullable(TemporaryComputerActivationRefV1Schema));

export function resolveRunnerDraftActivation(input: Pick<Draft, 'document'>): Readonly<{
    isTemporaryComputer: boolean;
    publicRef: ReturnType<typeof TemporaryComputerActivationRefV1Schema.parse> | null;
}> {
    const document = input.document;
    if (!document || typeof document !== 'object' || !('v' in document) || document.v !== 2) {
        return { isTemporaryComputer: false, publicRef: null };
    }
    const targetResult = StoredExecutionTargetSchema.safeParse(
        getSessionDraftDocumentFieldValue(document, { kind: 'authoring', fieldId: 'executionTarget' }),
    );
    const referenceResult = StoredActivationReferenceSchema.safeParse(
        getSessionDraftDocumentFieldValue(document, { kind: 'authoring', fieldId: 'temporaryComputerActivationRef' }),
    );
    const publicRef = referenceResult.success ? referenceResult.data : null;
    return { isTemporaryComputer: (targetResult.success && targetResult.data?.kind === 'temporary_computer') || publicRef !== null, publicRef };
}

export function isNewSessionDraftDeletionBlocked(input: Readonly<{
    draft: Draft;
    accountId: string;
    operations: Parameters<typeof isNewSessionDraftLaunchInCustody>[0]['operations'];
}>): boolean {
    // The draft tombstone atomically closes temporary-computer activation.
    if (resolveRunnerDraftActivation(input.draft).isTemporaryComputer) return false;
    return isNewSessionDraftLaunchInCustody({ accountId: input.accountId,
        launchUserAttemptId: input.draft.localSupplement.launchUserAttemptId, operations: input.operations });
}
