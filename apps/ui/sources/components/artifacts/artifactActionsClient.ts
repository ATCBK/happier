import * as React from 'react';
import { v5 as uuidv5 } from 'uuid';
import type { z } from 'zod/mini';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ArtifactActionOutputSchemasV1, type ArtifactActionInputV1, type ArtifactStorageUsageV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { DocCollaborationActionInputSchemasV1, DocCollaborationActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';
import { ArtifactAccessActionOutputSchemasV1, type ArtifactAccessGrantSetInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getStorage, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute, type FrontDoorActionExecute, type UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { writeDiscussionSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { buildDiscussionRouteHref } from '@/components/discussions/discussionRoutes';
import type { ComposerStructuredInputMention } from '@/components/sessions/agentInput/structuredInputMentions';
import { seedDiscussionDraft } from '@/components/discussions/useDiscussionDraft';

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

type SurfaceMutationActionId = 'artifact.create' | 'artifact.publish_from_file' | 'artifact.access.grants.set'
    | 'artifact.update' | 'artifact.revisions.restore' | 'artifact.delete' | 'doc.comment.reply' | 'doc.edit.propose' | 'doc.edit.accept' | 'doc.edit.decline';
type SurfaceActionId = 'artifact.revisions.list' | 'artifact.storage.usage' | 'doc.read' | 'artifact.access.grants.list' | SurfaceMutationActionId;
const SURFACE_OUTPUT_SCHEMAS = { ...ArtifactActionOutputSchemasV1, ...DocCollaborationActionOutputSchemasV1,
    ...ArtifactAccessActionOutputSchemasV1 };
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

export function createArtifactActionsClient(scope: ServerAccountScope,
    execute: (...args: Parameters<FrontDoorActionExecute>) => ReturnType<FrontDoorActionExecute> = createFrontDoorActionExecute()) {
    const dispatch = (actionId: SurfaceActionId, input: unknown, operation?: Pick<UiActionOperation, 'presentUserConfirmation' | 'defaultSessionId'>) => execute(actionId, input, {
        surface: 'ui', serverId: scope.serverId, expectedAccountId: scope.accountId,
        // These private UI methods are direct person intents, not an agent/plugin authority adapter.
        ...(actionId === 'doc.edit.accept' || actionId === 'doc.edit.decline' || actionId === 'artifact.publish_from_file'
            ? { authority: 'present_user', actionCaller: { kind: 'host' } } as const : {}),
        ...(operation?.defaultSessionId ? { defaultSessionId: operation.defaultSessionId } : {}),
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
        operation?: Pick<UiActionOperation, 'presentUserConfirmation' | 'defaultSessionId'>) => {
        const result = await dispatch(actionId, input, operation);
        const pending = result?.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
        return pending?.success
            ? { approvalId: pending.data.artifactId } as const
            : readOutcome(actionId, result);
    };
    return {
        /** Captured alongside every operation; a modal must not rebind this client to the focused Home. */
        scope,
        /** Seed the existing private Discussion draft from the source's captured Home. */
        beginPassageComment: (passage: DocPassageRefV1) => {
            const draftId = uuidv5(JSON.stringify(['happier.doc-passage-comment-draft.v1', passage.ref.serverId,
                passage.ref.artifactId, passage.revision.headerVersion, passage.revision.bodyVersion,
                passage.range.start, passage.range.end]), uuidv5.URL);
            writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion', draftId }, patch: { passage } });
            return buildDiscussionRouteHref({ target: { kind: 'new', address: { serverId: scope.serverId }, draftId } });
        },
        /**
         * Re-attach an existing passage thread to a fresh basis: the thread's own draft carries the passage
         * captured at the current revision, so the person's next comment is posted into that same thread
         * through `doc.comment.reply`. Nothing is sent and the old comments are not touched.
         */
        beginPassageReattach: (input: Readonly<{ discussionId: string; passage: DocPassageRefV1; returnArtifactId?: string }>) => {
            writeDiscussionSessionDraft({ scope, address: { kind: 'discussion', discussionId: input.discussionId }, patch: { passage: input.passage } });
            return buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: scope.serverId }, discussionId: input.discussionId },
                ...(input.returnArtifactId ? { returnArtifactId: input.returnArtifactId } : {}) });
        },
        /**
         * Prepare (never send) a reply to a suggested edit in its own thread: the thread's draft gets the
         * addressed request unless it already holds the person's words, and the thread opens replying to it.
         */
        beginProposalReply: (input: Readonly<{ proposalRef: DiscussionMessageRefV1; text: string; mentions: readonly ComposerStructuredInputMention[] }>) => {
            const { discussionId } = input.proposalRef.discussion;
            seedDiscussionDraft({ scope, address: { kind: 'discussion', discussionId }, text: input.text, mentions: input.mentions });
            return buildDiscussionRouteHref({ target: { kind: 'discussion', address: { serverId: scope.serverId }, discussionId,
                messageId: input.proposalRef.messageId } });
        },
        readDoc: (input: z.infer<typeof DocCollaborationActionInputSchemasV1['doc.read']>) => run('doc.read', input),
        replyToPassage: (input: z.infer<typeof DocCollaborationActionInputSchemasV1['doc.comment.reply']>) => runMutation('doc.comment.reply', input),
        proposeEdit: (input: z.infer<typeof DocCollaborationActionInputSchemasV1['doc.edit.propose']>) => runMutation('doc.edit.propose', input),
        acceptEdit: (input: z.infer<typeof DocCollaborationActionInputSchemasV1['doc.edit.accept']>) => runMutation('doc.edit.accept', input),
        declineEdit: (input: z.infer<typeof DocCollaborationActionInputSchemasV1['doc.edit.decline']>) => runMutation('doc.edit.decline', input),
        createArtifact: (input: ArtifactActionInputV1<'artifact.create'>) => runMutation('artifact.create', input),
        /** An explicit workspace wins; the captured Session remains the legacy source fallback. */
        publishWorkspaceFile: (input: ArtifactActionInputV1<'artifact.publish_from_file'>, source?: Readonly<{ sessionId: string }>) =>
            runMutation('artifact.publish_from_file', input, source ? { defaultSessionId: source.sessionId } : undefined),
        setAccessGrant: (input: ArtifactAccessGrantSetInputV1) => runMutation('artifact.access.grants.set', input),
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
