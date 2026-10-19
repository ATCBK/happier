import * as React from 'react';
import { v5 as uuidv5 } from 'uuid';
import type { z } from 'zod/mini';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ArtifactActionOutputSchemasV1, type ArtifactActionInputV1, type ArtifactStorageUsageV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { DocCollaborationActionInputSchemasV1, DocCollaborationActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { ArtifactAccessActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getStorage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { writeDiscussionSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildDiscussionRouteHref } from '@/components/discussions/discussionRoutes';

/**
 * The Artifacts surfaces reach document writes, history, restore and storage through the canonical `artifact.*`
 * Actions (ART-A1), never a second HTTP path: the UI is one more caller of the same spec the CLI,
 * MCP and agents use, with the same approval policy.
 */

export type ArtifactQuota = Readonly<{ budget: 'document' | 'account'; limitBytes: number; usedBytes: number }>;

export type ArtifactActionFailure = Readonly<{
    code: string;
    /** Present when a write was refused for an operator budget (`quota_exceeded`). */
    quota?: ArtifactQuota;
}>;

export type ArtifactActionOutcome<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; failure: ArtifactActionFailure }>;

type SurfaceMutationActionId = 'artifact.create' | 'artifact.update' | 'artifact.revisions.restore' | 'artifact.delete' | 'doc.comment.reply' | 'doc.edit.propose' | 'doc.edit.accept' | 'doc.edit.decline';
type SurfaceActionId = 'artifact.revisions.list' | 'artifact.storage.usage' | 'doc.read' | 'artifact.access.grants.list' | SurfaceMutationActionId;
const SURFACE_OUTPUT_SCHEMAS = { ...ArtifactActionOutputSchemasV1, ...DocCollaborationActionOutputSchemasV1,
    'artifact.access.grants.list': ArtifactAccessActionOutputSchemasV1['artifact.access.grants.list'] };
type SurfaceActionResult<Id extends SurfaceActionId> = z.infer<(typeof SURFACE_OUTPUT_SCHEMAS)[Id]>;

function readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The typed refusal of a failed Action result: its code and, for a budget, the named budget. */
export function readArtifactActionFailure(result: unknown): ArtifactActionFailure {
    const record = readRecord(result);
    const code = typeof record.errorCode === 'string' ? record.errorCode
        : typeof record.error === 'string' ? record.error : 'artifact_action_failed';
    if (code !== 'quota_exceeded') return { code };
    const details = readRecord(record.details);
    const budget = details.budget === 'document' || details.budget === 'account' ? details.budget : null;
    const limitBytes = typeof details.limitBytes === 'number' ? details.limitBytes : null;
    const usedBytes = typeof details.usedBytes === 'number' ? details.usedBytes : null;
    return budget !== null && limitBytes !== null && usedBytes !== null
        ? { code, quota: { budget, limitBytes, usedBytes } }
        : { code };
}

export function createArtifactActionsClient(scope: ServerAccountScope, execute = createFrontDoorActionExecute()) {
    const dispatch = (actionId: SurfaceActionId, input: unknown, operation?: Pick<UiActionOperation, 'presentUserConfirmation'>) => execute(actionId, input, {
        surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        // These private UI methods are direct person intents, not an agent/plugin authority adapter.
        ...(actionId === 'doc.edit.accept' || actionId === 'doc.edit.decline'
            ? { authority: 'present_user', actionCaller: { kind: 'host' } } as const : {}),
        ...(operation?.presentUserConfirmation ? { authority: 'present_user', actionCaller: { kind: 'host' },
            presentUserConfirmation: operation.presentUserConfirmation } as const : {}),
    }).catch(() => null);
    const readOutcome = <Id extends SurfaceActionId>(actionId: Id, result: Awaited<ReturnType<typeof dispatch>>): ArtifactActionOutcome<SurfaceActionResult<Id>> => {
        if (!result) return { ok: false, failure: { code: 'artifact_action_failed' } };
        if (!result.ok) return { ok: false, failure: readArtifactActionFailure(result) };
        const parsed = SURFACE_OUTPUT_SCHEMAS[actionId].safeParse(result.result);
        return parsed.success
            ? { ok: true, value: parsed.data as SurfaceActionResult<Id> }
            : { ok: false, failure: { code: 'artifact_action_invalid_result' } };
    };
    const run = async <Id extends SurfaceActionId>(actionId: Id, input: unknown): Promise<ArtifactActionOutcome<SurfaceActionResult<Id>>> => {
        return readOutcome(actionId, await dispatch(actionId, input));
    };
    const runMutation = async <Id extends SurfaceMutationActionId>(actionId: Id, input: unknown,
        operation?: Pick<UiActionOperation, 'presentUserConfirmation'>) => {
        const result = await dispatch(actionId, input, operation);
        const pending = result?.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
        return pending?.success
            ? { approvalId: pending.data.artifactId } as const
            : readOutcome(actionId, result);
    };
    return {
        /** Seed the existing private Discussion draft from the source's captured Home. */
        beginPassageComment: (passage: DocPassageRefV1) => {
            const draftId = uuidv5(JSON.stringify(['happier.doc-passage-comment-draft.v1', passage.ref.serverId,
                passage.ref.artifactId, passage.revision.headerVersion, passage.revision.bodyVersion,
                passage.range.start, passage.range.end]), uuidv5.URL);
            writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion', draftId }, patch: { passage } });
            return buildDiscussionRouteHref({ target: { kind: 'new', address: { serverId: scope.serverId }, draftId } });
        },
        readDoc: (input: z.infer<typeof DocCollaborationActionInputSchemasV1['doc.read']>) => run('doc.read', input),
        replyToPassage: (input: z.infer<typeof DocCollaborationActionInputSchemasV1['doc.comment.reply']>) => runMutation('doc.comment.reply', input),
        proposeEdit: (input: z.infer<typeof DocCollaborationActionInputSchemasV1['doc.edit.propose']>) => runMutation('doc.edit.propose', input),
        acceptEdit: (input: z.infer<typeof DocCollaborationActionInputSchemasV1['doc.edit.accept']>) => runMutation('doc.edit.accept', input),
        declineEdit: (input: z.infer<typeof DocCollaborationActionInputSchemasV1['doc.edit.decline']>) => runMutation('doc.edit.decline', input),
        createArtifact: (input: ArtifactActionInputV1<'artifact.create'>) => runMutation('artifact.create', input),
        updateArtifact: (input: ArtifactActionInputV1<'artifact.update'>) => runMutation('artifact.update', input),
        storageUsage: () => run('artifact.storage.usage', {}),
        listRevisions: (artifactId: string) => run('artifact.revisions.list', { artifactId }),
        /** Who the document is shared with (its grant roster), for the page's audience line. */
        listAccessGrants: (artifactId: string) => run('artifact.access.grants.list', { artifactId }),
        restoreRevision: (input: Readonly<{ artifactId: string; bodyVersion: number; expectedRevision: Readonly<{ headerVersion: number; bodyVersion: number }> }>) =>
            runMutation('artifact.revisions.restore', input),
        deleteArtifact: (input: Readonly<{ artifactId: string; expectedRevision: Readonly<{ headerVersion: number; bodyVersion: number }> }>,
            operation?: Pick<UiActionOperation, 'presentUserConfirmation'>) =>
            runMutation('artifact.delete', input, operation),
    };
}

export type ArtifactActionsClient = ReturnType<typeof createArtifactActionsClient>;

/** The Artifacts client for the active Account, or `null` while no Account is active. */
export function useArtifactActionsClient(): ArtifactActionsClient | null {
    const scope = useActiveServerAccountScope();
    const serverId = scope?.serverId ?? null;
    const accountId = scope?.accountId ?? null;
    return React.useMemo(
        () => (serverId !== null && accountId !== null ? createArtifactActionsClient({ serverId, accountId }) : null),
        [serverId, accountId],
    );
}

/**
 * Read the active Account's authoritative usage on mount and whenever stored Artifact versions
 * change. Retain the last successful read during refresh; never carry it to another
 * Account. The server, not the retained local heads, accounts for storage and revision bytes.
 */
export function useArtifactStorageUsage(): ArtifactStorageUsageV1 | null {
    const client = useArtifactActionsClient();
    const storageRevision = getStorage()((state) => state.artifactsStorageRevision);
    const [snapshot, setSnapshot] = React.useState<Readonly<{ client: ArtifactActionsClient; usage: ArtifactStorageUsageV1 }> | null>(null);
    React.useEffect(() => {
        if (!client) return;
        let current = true;
        void client.storageUsage().then((outcome) => { if (current && outcome.ok) setSnapshot({ client, usage: outcome.value }); });
        return () => { current = false; };
    }, [client, storageRevision]);
    return snapshot && snapshot.client === client ? snapshot.usage : null;
}
