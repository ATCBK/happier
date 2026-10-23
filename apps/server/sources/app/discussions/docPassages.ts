import { DiscussionReplyTargetV1Schema, type DiscussionDocPassageReplyTargetV1 } from '@happier-dev/protocol/discussions/replyTargets';
import { DiscussionMessageContentV1StoredSchema } from '@happier-dev/protocol/discussions/content';
import type { StrictSessionStoredMessageContentEnvelope } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { mayInjectResourceContextInTx, type ContextDisclosureResource } from '@/app/session/access/sessionContextInjection';
import { readArtifactForCallerInTx, resolveArtifactAudienceInTx } from '@/app/artifacts/artifactAccessService';
import { artifactContextStorageAdapter } from '@/app/artifacts/artifactContextInjection';
import type { Tx } from '@/storage/inTx';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';

export type DiscussionDocSource = DiscussionDocPassageReplyTargetV1['doc'];

/** Admit the source's full publication cohort before its parent; the reader below still decides disclosure. */
export async function readDiscussionDocSourceAuthorityAccountIdsInTx(tx: Tx, source: DiscussionDocSource | null): Promise<string[]> {
    if (!source) return [];
    return resolveArtifactAudienceInTx(tx, source.ref.artifactId);
}

/** New posts resolve the existing parent rather than inventing a pending message identity. */
export async function resolveDiscussionDocTargetInTx(tx: Tx, input: Readonly<{
    discussionId: string; replyTarget?: ReturnType<typeof DiscussionReplyTargetV1Schema.parse>;
}>): Promise<DiscussionResult<DiscussionDocSource | null>> {
    if (input.replyTarget?.kind !== 'message') return discussionSuccess(input.replyTarget?.kind === 'doc_passage' ? input.replyTarget.doc : null);
    const parent = await tx.discussionMessage.findFirst({ where: { discussionId: input.discussionId, id: input.replyTarget.messageId },
        select: { id: true, replyTargetV1: true } });
    if (!parent) return discussionFailure('discussion_invalid_reply_target');
    const resolved = await resolveDiscussionDocSourcesInTx(tx, { discussionId: input.discussionId, messages: [parent] });
    return resolved.ok ? discussionSuccess(resolved.value.get(parent.id) ?? null) : resolved;
}

/** Resolve root inheritance in batches, including roots outside the requested page. */
export async function resolveDiscussionDocSourcesInTx(tx: Tx, input: Readonly<{
    discussionId: string; messages: readonly Readonly<{ id: string; replyTargetV1: unknown }>[];
}>): Promise<DiscussionResult<ReadonlyMap<string, DiscussionDocSource | null>>> {
    const targets = new Map<string, ReturnType<typeof DiscussionReplyTargetV1Schema.parse> | null>();
    let rows = input.messages;
    for (;;) {
        for (const row of rows) {
            const parsed = row.replyTargetV1 == null ? null : DiscussionReplyTargetV1Schema.safeParse(row.replyTargetV1);
            if (parsed && !parsed.success) return discussionFailure('discussion_invalid_reply_target');
            targets.set(row.id, parsed?.success ? parsed.data : null);
        }
        const missing = [...new Set([...targets.values()].flatMap(target =>
            target?.kind === 'message' && !targets.has(target.messageId) ? [target.messageId] : []))];
        if (missing.length === 0) break;
        rows = await tx.discussionMessage.findMany({ where: { discussionId: input.discussionId, id: { in: missing } },
            select: { id: true, replyTargetV1: true } });
        if (rows.length !== missing.length) return discussionFailure('discussion_invalid_reply_target');
    }
    const sources = new Map<string, DiscussionDocSource | null>();
    for (const row of input.messages) {
        let id = row.id;
        const visited = new Set<string>();
        for (;;) {
            if (visited.has(id)) return discussionFailure('discussion_invalid_reply_target');
            visited.add(id);
            const target = targets.get(id);
            if (target?.kind !== 'message') {
                sources.set(row.id, target?.kind === 'doc_passage' ? target.doc : null);
                break;
            }
            id = target.messageId;
        }
    }
    return discussionSuccess(sources);
}

/** A decoded plain payload cannot claim a different Doc from its admitted root. */
export function validateDiscussionDocContentSource(input: Readonly<{
    content: StrictSessionStoredMessageContentEnvelope; source: DiscussionDocSource | null; root: boolean;
}>): boolean {
    if (input.content.t === 'encrypted') return true;
    const parsed = DiscussionMessageContentV1StoredSchema.safeParse(input.content.v);
    if (!parsed.success) return false;
    const value = parsed.data;
    const passage = 'kind' in value
        ? value.kind === 'doc_passage_comment' ? value.passage : value.kind === 'doc_edit_proposal' ? value.proposal.target : null : null;
    if (!passage) return !input.root;
    // Both references are admitted on this authenticated Home. Profile labels
    // can differ across clients; the stored Artifact identity is authoritative.
    if (!input.source || passage.ref.artifactId !== input.source.ref.artifactId) return false;
    // A redo proposal may use a later revision in the same thread. A new root
    // binds its full source basis; replies inherit the original root identity.
    return !input.root || (passage.revision.headerVersion === input.source.revision.headerVersion
        && passage.revision.bodyVersion === input.source.revision.bodyVersion);
}

/** Quote writes and executable reads both reuse G's current source→destination policy. */
export async function admitDiscussionDocSourceInTx(tx: Tx, input: Readonly<{
    actorAccountId: string; authentication: SessionAccessAuthentication;
    source: DiscussionDocSource | null; destination?: ContextDisclosureResource;
}>): Promise<DiscussionResult<void>> {
    if (!input.source) return discussionSuccess(undefined);
    const read = await readArtifactForCallerInTx(tx, { actorAccountId: input.actorAccountId, artifactId: input.source.ref.artifactId });
    if (!read.ok) return discussionFailure('discussion_content_unavailable');
    if (input.destination) {
        const disclosure = await mayInjectResourceContextInTx(tx, { configuringAccountId: input.actorAccountId,
            authentication: input.authentication,
            source: { kind: 'resource', resourceId: input.source.ref.artifactId, adapter: artifactContextStorageAdapter },
            destination: input.destination });
        if (!disclosure.ok) return discussionFailure('discussion_access_forbidden');
    }
    return discussionSuccess(undefined);
}
