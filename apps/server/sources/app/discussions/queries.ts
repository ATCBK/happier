import { DISCUSSION_DEFAULT_PAGE_SIZE_V1, DISCUSSION_MAX_PAGE_SIZE_V1, DiscussionListQueryV1Schema, type DiscussionDetailsResponseV1, type DiscussionListResponseV1, type DiscussionMessagesResponseV1 } from '@happier-dev/protocol/discussions/api';
import { DiscussionAnchorV1Schema, DiscussionReplyTargetV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import type { DiscussionSummaryV1, DiscussionMessageV1 } from '@happier-dev/protocol/discussions/models';
import { admitDiscussionDocSourceInTx, resolveDiscussionDocSourcesInTx, validateDiscussionDocContentSource, type DiscussionDocSource } from './docPassages';
import { inReadSnapshot, type Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { resolveDiscussionContextInTx, resolveDiscussionContextsInTx, discussionCandidateWhere, discussionCandidateSql, type DiscussionContext } from './access';
import { buildDiscussionListCursorPredicate, decodeDiscussionListCursorV1, encodeDiscussionListCursorV1 } from './pagination';
import { DISCUSSION_MESSAGE_SELECT, DISCUSSION_SELECT, loadDiscussionViewerFactsInTx, projectDiscussionAccountActorsInTx, projectDiscussionCapabilitiesV1, projectDiscussionMessageV1, projectDiscussionSummaryV1, validateDiscussionStoredContent, validateDiscussionStoredMessage, type DiscussionRow, type DiscussionMessageRow } from './projection';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';
import { readHeldDiscussionPendingInputsInTx } from '@/app/session/pending/pendingMessageService';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { admitDiscussionSecondOpinionSourceInTx } from './secondOpinion';
import { prismaRuntime as sql } from '@/storage/prisma';
import { discussionJsonText, discussionSqlName as name, discussionSqlTimestamp } from './readSql';

/** Only the authenticated runtime/original supplies an executable destination. */
function contentDestination(authentication: SessionAccessAuthentication) {
    return authentication.contentDisclosureSessionId
        ? { kind: 'session' as const, sessionId: authentication.contentDisclosureSessionId } : undefined;
}

function pageSize(limit?: number): number {
    return limit === undefined || !Number.isSafeInteger(limit) || limit < 1
        ? DISCUSSION_DEFAULT_PAGE_SIZE_V1 : Math.min(limit, DISCUSSION_MAX_PAGE_SIZE_V1);
}

/** Mutation and read responses project the same live grant, key and private cursor facts. */
export async function projectDiscussionForViewerInTx(tx: Tx, input: Readonly<{
    context: DiscussionContext; viewerAccountId: string; authentication: SessionAccessAuthentication; discussion: DiscussionRow;
}>): Promise<DiscussionResult<DiscussionSummaryV1>> {
    const result = await projectDiscussionsForViewerInTx(tx, { viewerAccountId: input.viewerAccountId, authentication: input.authentication,
        discussions: [input.discussion], contexts: new Map([[input.discussion.id, input.context]]) });
    return result.ok ? discussionSuccess(result.value[0]!) : result;
}

/** Summary pages keep latest rows, actors, authors and private cursor reads set-oriented. */
export async function projectDiscussionsForViewerInTx(tx: Tx, input: Readonly<{
    viewerAccountId: string; authentication: SessionAccessAuthentication;
    discussions: readonly DiscussionRow[]; contexts: ReadonlyMap<string, DiscussionContext>;
    anchorDocArtifactId?: string;
}>): Promise<DiscussionResult<DiscussionSummaryV1[]>> {
    const facts = await loadDiscussionViewerFactsInTx(tx, { viewerAccountId: input.viewerAccountId, discussions: input.discussions, tracked: true,
        includeFirstMessage: input.anchorDocArtifactId !== undefined });
    const firstMessages = new Map<string, DiscussionMessageV1 | null>();
    const unavailableLatestContent = new Set<string>();
    const destination = contentDestination(input.authentication);
    for (const discussion of input.discussions) {
        const context = input.contexts.get(discussion.id), current = facts.get(discussion.id);
        if (!context || !current) return discussionFailure('discussion_invalid_content');
        const failure = validateDiscussionStoredContent(discussion.titleContent, context.storageMode, 'title')
            ?? validateDiscussionStoredMessage(current.latestMessage, context.storageMode);
        if (failure) return discussionFailure(failure);
        if (input.anchorDocArtifactId !== undefined) {
            const root = current.firstMessage;
            if (!root || root.discussionId !== discussion.id || root.seq !== 1) return discussionFailure('discussion_invalid_content');
            const rootFailure = validateDiscussionStoredMessage(root, context.storageMode);
            if (rootFailure) return discussionFailure(rootFailure);
            const target = DiscussionReplyTargetV1Schema.safeParse(root.replyTargetV1);
            if (!target.success || target.data.kind !== 'doc_passage'
                || target.data.doc.ref.artifactId !== input.anchorDocArtifactId
                || !validateDiscussionDocContentSource({ content: root.content as DiscussionMessageV1['content'], source: target.data.doc, root: true })) {
                return discussionFailure('discussion_invalid_content');
            }
            if (!context.keyReadiness) firstMessages.set(discussion.id, null);
            else {
                const readable = await projectReadableMessagesInTx(tx, { discussionId: discussion.id, actorAccountId: input.viewerAccountId,
                    authentication: input.authentication, context, rows: [root], unavailableDocSources: 'omit' });
                if (!readable.ok) {
                    if (readable.error !== 'discussion_content_unavailable' && readable.error !== 'discussion_access_forbidden') return readable;
                    firstMessages.set(discussion.id, null);
                } else firstMessages.set(discussion.id, readable.value.messages[0] ?? null);
            }
            // Scoped summaries disclose only the exact admitted root, never latest content.
            continue;
        }
        const sources = await resolveDiscussionDocSourcesInTx(tx, { discussionId: discussion.id, messages: [current.latestMessage] });
        if (!sources.ok) return sources;
        const admitted = await admitDiscussionDocSourceInTx(tx, { actorAccountId: input.viewerAccountId,
            authentication: input.authentication, source: sources.value.get(current.latestMessage.id) ?? null, destination });
        const executableSource = destination ? await admitDiscussionSecondOpinionSourceInTx(tx, {
            actorAccountId: input.viewerAccountId, authentication: input.authentication, anchor: discussion.anchorV1, destination,
        }) : discussionSuccess(undefined);
        // The Discussion grant still admits metadata, but cannot disclose its independent Doc source.
        if (!admitted.ok || !executableSource.ok) unavailableLatestContent.add(discussion.id);
    }
    const actors = await projectDiscussionAccountActorsInTx(tx, input.discussions.map(row => facts.get(row.id)!.latestMessage),
        input.discussions.flatMap(row => facts.get(row.id)!.participantAccountIds));
    const actorsByAccountId = new Map(actors.participants.flatMap(actor => actor ? [[actor.accountId, actor] as const] : []));
    return discussionSuccess(input.discussions.map((discussion, i) => {
        const context = input.contexts.get(discussion.id)!;
        const summary = projectDiscussionSummaryV1({ context, discussion, viewerAccountId: input.viewerAccountId, facts: facts.get(discussion.id)!,
            includeLatestMessageContent: input.anchorDocArtifactId === undefined && !unavailableLatestContent.has(discussion.id),
            latestMessageAccountActor: actors.messages[i]?.accountActor ?? null,
            latestMessageRequesterAccountActor: actors.messages[i]?.requesterAccountActor ?? null,
            participantAccounts: facts.get(discussion.id)!.participantAccountIds.map(accountId => actorsByAccountId.get(accountId)!),
            capabilities: projectDiscussionCapabilitiesV1({ access: context.access, keyReadiness: context.keyReadiness, discussionArchived: discussion.archivedAt !== null }) });
        return input.anchorDocArtifactId === undefined ? summary : { ...summary, firstMessage: firstMessages.get(discussion.id)! };
    }));
}

export async function readDiscussionRowInTx(tx: Tx, input: Readonly<{ discussionId: string }>): Promise<DiscussionRow | null> {
    return tx.discussion.findUnique({ where: { id: input.discussionId }, select: DISCUSSION_SELECT });
}

type Reader = Readonly<{ actorAccountId: string; authentication: SessionAccessAuthentication }>;

/** Exact and paged reads share admission; pages may withhold independently unavailable Doc rows. */
export async function projectReadableMessagesInTx(tx: Tx, input: Reader & Readonly<{
    discussionId: string; context: DiscussionContext;
    rows: readonly DiscussionMessageRow[];
    unavailableDocSources?: 'omit';
}>): Promise<DiscussionResult<Readonly<{ messages: DiscussionMessageV1[]; docSources: ReadonlyMap<string, DiscussionDocSource | null> }>>> {
    for (const row of input.rows) {
        const failure = validateDiscussionStoredMessage(row, input.context.storageMode);
        if (failure) return discussionFailure(failure);
    }
    const destination = contentDestination(input.authentication);
    if (destination && input.rows.length > 0) {
        const discussion = await tx.discussion.findUnique({ where: { id: input.discussionId }, select: { anchorV1: true } });
        const executableSource = await admitDiscussionSecondOpinionSourceInTx(tx, { ...input, anchor: discussion?.anchorV1, destination });
        if (!executableSource.ok) return executableSource;
    }
    const sources = await resolveDiscussionDocSourcesInTx(tx, { discussionId: input.discussionId, messages: input.rows });
    if (!sources.ok) return sources;
    const admitted = new Map<string, boolean>();
    for (const source of sources.value.values()) {
        if (!source || admitted.has(source.ref.artifactId)) continue;
        const access = await admitDiscussionDocSourceInTx(tx, { ...input, source, destination });
        // Human history can omit unavailable Doc rows. An executable disclosure
        // must report refusal, not silently return a partial protected context.
        if (!access.ok && (destination || input.unavailableDocSources !== 'omit')) return access;
        admitted.set(source.ref.artifactId, access.ok);
    }
    const readable = input.rows.filter(row => {
        const source = sources.value.get(row.id);
        return !source || admitted.get(source.ref.artifactId) === true;
    });
    const actors = await projectDiscussionAccountActorsInTx(tx, readable);
    const messages = readable.map((row, index) => projectDiscussionMessageV1(row, input.actorAccountId,
        actors.messages[index]?.accountActor ?? null, actors.messages[index]?.requesterAccountActor ?? null));
    const addresses = messages.flatMap(message => (message.addressingV1?.participantSessionIds ?? []).map(participantSessionId => ({
        discussionId: input.discussionId, messageId: message.id, throughSeq: message.seq, participantSessionId,
    })));
    const held = await readHeldDiscussionPendingInputsInTx(tx, addresses);
    return discussionSuccess({ docSources: sources.value, messages: messages.map(message => {
        const deliveries = (message.addressingV1?.participantSessionIds ?? []).flatMap(participantSessionId => held.has(deriveDiscussionFollowInputLocalIdV1({
            discussionId: input.discussionId, messageId: message.id, throughSeq: message.seq, participantSessionId,
        })) ? [{ participantSessionId, disposition: 'held' as const, code: 'session_input_target_unavailable' as const }] : []);
        return deliveries.length ? { ...message, participantDeliveryV1: deliveries } : message;
    }) });
}

/** Internal exact read on the supplied transaction; no second codec or transaction. */
export async function readDiscussionMessageInTx(tx: Tx, input: Reader & Readonly<{
    discussionId: string; messageId: string;
}>): Promise<DiscussionResult<DiscussionMessageV1>> {
    const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId,
        accountId: input.actorAccountId, authentication: input.authentication });
    if (!context) return discussionFailure('discussion_not_found');
    const row = await tx.discussionMessage.findFirst({ where: { discussionId: input.discussionId, id: input.messageId }, select: DISCUSSION_MESSAGE_SELECT });
    if (!row) return discussionFailure('discussion_not_found');
    const projected = await projectReadableMessagesInTx(tx, { ...input, context, rows: [row] });
    return projected.ok ? discussionSuccess(projected.value.messages[0]!) : projected;
}

/** Candidate grants narrow before paging; current admission still decides every returned row. */
export async function listDiscussions(input: Reader & Readonly<{
    state?: 'active' | 'archived'; cursor?: string; limit?: number; anchorSessionId?: string; creationLocalId?: string; anchorDocArtifactId?: string;
}>): Promise<DiscussionResult<DiscussionListResponseV1>> {
    if (input.anchorDocArtifactId !== undefined && !DiscussionListQueryV1Schema.safeParse({
        anchorDocArtifactId: input.anchorDocArtifactId, state: input.state,
    }).success) return discussionFailure('discussion_invalid_content');
    return inReadSnapshot(async tx => {
        const cursor = input.cursor === undefined ? null : decodeDiscussionListCursorV1(input.cursor);
        if (input.cursor !== undefined && !cursor) return discussionFailure('discussion_invalid_content');
        const take = pageSize(input.limit);
        const discussions: DiscussionSummaryV1[] = [];
        let frontier = cursor;
        // Access may disappear between candidate discovery and read. Continue
        // keyset traversal rather than making a denied row hide later results.
        for (;;) {
            // SQLite's Prisma connector has no JSON-path filter. Select exact
            // Doc candidates in SQL on every provider before ORM/page admission.
            const position = frontier ? discussionSqlTimestamp(new Date(frontier.at)) : sql.empty;
            const scopedIds = input.anchorDocArtifactId === undefined ? null : await tx.$queryRaw<{ id: string }[]>(sql.sql`
                SELECT d.${name('id')} AS id FROM ${name('Discussion')} d
                WHERE ${discussionCandidateSql(input.actorAccountId)} AND d.${name('archivedAt')} IS NULL
                    AND ${discussionJsonText(sql.sql`d.${name('anchorV1')}`, ['kind'])} = 'doc'
                    AND ${discussionJsonText(sql.sql`d.${name('anchorV1')}`, ['doc', 'ref', 'artifactId'])} = ${input.anchorDocArtifactId}
                    ${input.anchorSessionId ? sql.sql`AND d.${name('anchorSessionId')} = ${input.anchorSessionId}` : sql.empty}
                    ${input.creationLocalId ? sql.sql`AND d.${name('createdByAccountId')} = ${input.actorAccountId} AND d.${name('creationLocalId')} = ${input.creationLocalId}` : sql.empty}
                    ${frontier ? sql.sql`AND (d.${name('lastMessageAt')} < ${position} OR (d.${name('lastMessageAt')} = ${position} AND d.${name('id')} < ${frontier.id}))` : sql.empty}
                ORDER BY d.${name('lastMessageAt')} DESC, d.${name('id')} DESC LIMIT ${take + 1}`);
            if (scopedIds?.length === 0) return discussionSuccess({ discussions, nextCursor: null });
            const rows = await tx.discussion.findMany({
                where: {
                    AND: [discussionCandidateWhere(input.actorAccountId), ...(frontier ? [buildDiscussionListCursorPredicate(frontier)] : [])],
                    archivedAt: input.state === 'archived' ? { not: null } : null,
                    ...(scopedIds ? { id: { in: scopedIds.map(row => row.id) } } : {}),
                    ...(input.anchorSessionId ? { anchorSessionId: input.anchorSessionId } : {}),
                    ...(input.creationLocalId ? { createdByAccountId: input.actorAccountId, creationLocalId: input.creationLocalId } : {}),
                }, select: DISCUSSION_SELECT, orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }], take: take + 1,
            });
            if (rows.length === 0) return discussionSuccess({ discussions, nextCursor: null });
            const contexts = await resolveDiscussionContextsInTx(tx, { discussionIds: rows.map(row => row.id), accountId: input.actorAccountId, authentication: input.authentication });
            const admitted = rows.filter(row => {
                if (!contexts.has(row.id)) return false;
                if (input.anchorDocArtifactId === undefined) return true;
                const anchor = DiscussionAnchorV1Schema.safeParse(row.anchorV1);
                return row.archivedAt === null && anchor.success && anchor.data.kind === 'doc'
                    && anchor.data.doc.ref.artifactId === input.anchorDocArtifactId;
            });
            const selected = admitted.slice(0, take - discussions.length);
            const projected = await projectDiscussionsForViewerInTx(tx, { contexts, discussions: selected,
                viewerAccountId: input.actorAccountId, authentication: input.authentication,
                ...(input.anchorDocArtifactId === undefined ? {} : { anchorDocArtifactId: input.anchorDocArtifactId }) });
            if (!projected.ok) return projected;
            discussions.push(...projected.value);
            const lastSelected = selected[selected.length - 1];
            if (lastSelected) frontier = { v: 1, at: lastSelected.lastMessageAt.getTime(), id: lastSelected.id };
            if (admitted.length > selected.length) return discussionSuccess({ discussions, nextCursor: frontier ? encodeDiscussionListCursorV1(frontier) : null });
            const last = rows[rows.length - 1]!;
            frontier = { v: 1, at: last.lastMessageAt.getTime(), id: last.id };
            if (rows.length <= take) return discussionSuccess({ discussions, nextCursor: null });
        }
    });
}

/** Exact reads never confirm identity to an unauthorized principal. */
export async function getDiscussion(input: Reader & Readonly<{ discussionId: string }>): Promise<DiscussionResult<DiscussionDetailsResponseV1>> {
    return inReadSnapshot(async tx => {
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
        if (!context) return discussionFailure('discussion_not_found');
        const discussion = await readDiscussionRowInTx(tx, input);
        if (!discussion) return discussionFailure('discussion_not_found');
        const projected = await projectDiscussionForViewerInTx(tx, { context, discussion,
            viewerAccountId: input.actorAccountId, authentication: input.authentication });
        return projected.ok ? discussionSuccess({ discussion: projected.value }) : projected;
    });
}

/** Ordered, cursor-neutral reads apply the requested sequence ceiling before paging. */
export async function readDiscussionMessages(input: Reader & Readonly<{
    discussionId: string; beforeSeq?: number; afterSeq?: number; throughSeq?: number; limit?: number;
}>): Promise<DiscussionResult<DiscussionMessagesResponseV1>> {
    if (input.beforeSeq !== undefined && input.afterSeq !== undefined) return discussionFailure('discussion_invalid_content');
    return inReadSnapshot(async tx => {
        const context = await resolveDiscussionContextInTx(tx, { discussionId: input.discussionId, accountId: input.actorAccountId, authentication: input.authentication });
        if (!context) return discussionFailure('discussion_not_found');
        const discussion = await readDiscussionRowInTx(tx, input);
        if (!discussion) return discussionFailure('discussion_not_found');
        const ascending = input.afterSeq !== undefined;
        const take = pageSize(input.limit);
        const messages: DiscussionMessageV1[] = [];
        let frontier = input.afterSeq ?? input.beforeSeq;
        // Withheld Doc rows must not consume a visible slot or strand the caller
        // on an empty page before independently authorized conversation history.
        while (messages.length < take) {
            const remaining = take - messages.length;
            const rows = await tx.discussionMessage.findMany({
                where: { discussionId: discussion.id, seq: {
                    ...(frontier === undefined ? {} : ascending ? { gt: frontier } : { lt: frontier }),
                    ...(input.throughSeq === undefined ? {} : { lte: input.throughSeq }),
                } }, select: DISCUSSION_MESSAGE_SELECT, orderBy: { seq: ascending ? 'asc' : 'desc' }, take: remaining,
            });
            if (rows.length === 0) break;
            const projected = await projectReadableMessagesInTx(tx, { ...input, context, rows, unavailableDocSources: 'omit' });
            if (!projected.ok) return projected;
            messages.push(...projected.value.messages);
            frontier = rows[rows.length - 1]!.seq;
            if (rows.length < remaining) break;
        }
        const ordered = ascending ? messages : messages.reverse();
        const first = ordered[0];
        const hasMoreOlder = first !== undefined && await tx.discussionMessage.findFirst({
            where: { discussionId: discussion.id, seq: { lt: first.seq } }, select: { id: true },
        }) !== null;
        return discussionSuccess({ messages: ordered,
            hasMoreOlder, messageSeq: input.throughSeq === undefined ? discussion.messageSeq : Math.min(discussion.messageSeq, input.throughSeq) });
    });
}
