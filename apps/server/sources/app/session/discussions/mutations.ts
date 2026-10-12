import {
    SessionDiscussionMessageContentV1Schema,
    SessionDiscussionProducerV1Schema,
    SessionDiscussionTitleV1Schema,
    computeSessionMutationEqualityPlainDigestV1,
    serializeSessionDiscussionMutationEqualityIntentV1,
    type SessionDiscussionCreateRequestV1,
    type SessionDiscussionCreateResponseV1,
    type SessionDiscussionDetailsResponseV1,
    type SessionDiscussionPostRequestV1,
    type SessionDiscussionPostResponseV1,
    type SessionDiscussionProducerV1,
    type SessionMutationEqualityEvidenceV1,
    type StrictSessionStoredMessageContentEnvelope,
} from "@happier-dev/protocol";

import { scheduleSessionActivityRemoteAlerts } from "@/app/activity/remoteAlerts/submitSessionActivityRemoteAlerts";
import { scheduleSessionPersonalEvent } from "@/app/session/personal/publishPersonalEvent";
import { afterTx, inTx, type Tx } from "@/storage/inTx";
import {
    filterAccountsWithCurrentSessionReadAccessInTx,
    resolveSessionDiscussionContextInTx,
    type SessionDiscussionSessionContext,
} from "./access";
import {
    markSessionDiscussionReadersChangedInTx,
    scheduleSessionDiscussionBadgeRefreshInTx,
} from "./changes";
import {
    SESSION_DISCUSSION_MESSAGE_SELECT,
    projectSessionDiscussionMessageV1,
    validateSessionDiscussionStoredContent,
    validateSessionDiscussionStoredMessage,
    type SessionDiscussionMessageRow,
    type SessionDiscussionRow,
} from "./projection";
import { projectAuthenticatedAccountActorsById } from "@/app/session/messages/projectSessionMessageAccountActors";
import {
    projectSessionDiscussionForViewerInTx,
    readSessionDiscussionRowInTx,
} from "./queries";
import { initializeNewSessionDiscussionCursorsInTx } from "./readState";
import { discussionFailure, discussionSuccess, type SessionDiscussionResult } from "./serviceTypes";
import { reconcileSessionDiscussionCreationIdentityRace } from "./createIdentityReconciliation";

type MessageIntent = Readonly<{
    localId: string;
    content: StrictSessionStoredMessageContentEnvelope;
    mentionedAccountIds: readonly string[];
    evidence: SessionMutationEqualityEvidenceV1;
}>;

type NormalizationFailure = Readonly<{
    error: "session_discussion_encryption_mode_mismatch" | "session_discussion_invalid_content";
}>;

type CreateSessionDiscussionParams = Readonly<{
    actorAccountId: string;
    sessionId: string;
    request: SessionDiscussionCreateRequestV1;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>;

function dedupePreservingOrder(values: readonly string[]): string[] {
    return [...new Set(values)];
}

function matchesStorageMode(
    envelope: StrictSessionStoredMessageContentEnvelope,
    context: SessionDiscussionSessionContext,
): boolean {
    return context.storageMode === "e2ee" ? envelope.t === "encrypted" : envelope.t === "plain";
}

/**
 * Equality evidence recognizes a repeated request; it never authorizes one.
 *
 * A Plain request is server-readable, so the digest is derived here from the
 * normalized semantic request and a client-asserted digest is never trusted in
 * its place. An E2EE request carries a Session-keyed tag the Home can compare
 * but not compute, which is why randomized ciphertext is deliberately excluded
 * from both.
 */
function resolveMessageIntent(params: Readonly<{
    context: SessionDiscussionSessionContext;
    localId: string;
    content: StrictSessionStoredMessageContentEnvelope;
    mentionedAccountIds: readonly string[];
    suppliedEvidence: SessionMutationEqualityEvidenceV1 | undefined;
}>): MessageIntent | NormalizationFailure {
    const { context, content } = params;
    if (!matchesStorageMode(content, context)) {
        return { error: "session_discussion_encryption_mode_mismatch" };
    }
    const mentionedAccountIds = dedupePreservingOrder(params.mentionedAccountIds);

    if (content.t === "encrypted") {
        if (!params.suppliedEvidence || params.suppliedEvidence.kind !== "e2eeTag") {
            return { error: "session_discussion_invalid_content" };
        }
        return { localId: params.localId, content, mentionedAccountIds, evidence: params.suppliedEvidence };
    }

    const parsed = SessionDiscussionMessageContentV1Schema.safeParse(content.v);
    if (!parsed.success) return { error: "session_discussion_invalid_content" };
    return {
        localId: params.localId,
        content,
        mentionedAccountIds,
        evidence: {
            kind: "plainDigest",
            digest: computeSessionMutationEqualityPlainDigestV1(
                serializeSessionDiscussionMutationEqualityIntentV1({
                    kind: "post",
                    content: parsed.data,
                    mentionedAccountIds,
                }),
            ),
        },
    };
}

function resolveCreationEvidence(params: Readonly<{
    context: SessionDiscussionSessionContext;
    titleContent: StrictSessionStoredMessageContentEnvelope;
    firstMessage: MessageIntent;
    suppliedEvidence: SessionMutationEqualityEvidenceV1 | undefined;
}>): SessionMutationEqualityEvidenceV1 | NormalizationFailure {
    const { context, titleContent, firstMessage } = params;
    if (!matchesStorageMode(titleContent, context)) {
        return { error: "session_discussion_encryption_mode_mismatch" };
    }
    if (titleContent.t !== firstMessage.content.t) {
        return { error: "session_discussion_encryption_mode_mismatch" };
    }
    if (titleContent.t === "encrypted") {
        if (!params.suppliedEvidence || params.suppliedEvidence.kind !== "e2eeTag") {
            return { error: "session_discussion_invalid_content" };
        }
        return params.suppliedEvidence;
    }
    const title = SessionDiscussionTitleV1Schema.safeParse(titleContent.v);
    const content = SessionDiscussionMessageContentV1Schema.safeParse(firstMessage.content.t === "plain"
        ? firstMessage.content.v
        : undefined);
    if (!title.success || !content.success) return { error: "session_discussion_invalid_content" };
    return {
        kind: "plainDigest",
        digest: computeSessionMutationEqualityPlainDigestV1(
            serializeSessionDiscussionMutationEqualityIntentV1({
                kind: "create",
                title: title.data,
                firstMessage: {
                    localId: firstMessage.localId,
                    content: content.data,
                    mentionedAccountIds: firstMessage.mentionedAccountIds,
                },
            }),
        ),
    };
}

function isNormalizationFailure(value: unknown): value is NormalizationFailure {
    return typeof value === "object" && value !== null && "error" in value;
}

function equalEvidence(stored: unknown, next: SessionMutationEqualityEvidenceV1): boolean {
    if (typeof stored !== "object" || stored === null) return false;
    const record = stored as Record<string, unknown>;
    if (next.kind === "plainDigest") {
        return record.kind === "plainDigest" && record.digest === next.digest;
    }
    return record.kind === "e2eeTag" && record.tag === next.tag;
}

function equalProducer(stored: unknown, next: SessionDiscussionProducerV1 | undefined): boolean {
    const storedParsed = stored === null || stored === undefined
        ? null
        : SessionDiscussionProducerV1Schema.safeParse(stored);
    if (!next) return storedParsed === null;
    if (storedParsed === null || !storedParsed.success) return false;
    return JSON.stringify(storedParsed.data) === JSON.stringify(next);
}

/**
 * Host-stamped Agent attribution is descriptive display metadata bound to the
 * Session it was produced in. It never selects the author: the authenticated
 * execution Account stays `authorAccountId`, so an Agent acting on one Account's
 * runtime cannot post as whoever asked for the work.
 */
function isValidProducerForSession(
    producer: SessionDiscussionProducerV1 | undefined,
    sessionId: string,
): boolean {
    if (!producer) return true;
    const parsed = SessionDiscussionProducerV1Schema.safeParse(producer);
    return parsed.success && parsed.data.sessionId === sessionId;
}

async function validateMentionTargetsInTx(tx: Tx, params: Readonly<{
    sessionId: string;
    mentionedAccountIds: readonly string[];
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<boolean> {
    if (params.mentionedAccountIds.length === 0) return true;
    const readable = await filterAccountsWithCurrentSessionReadAccessInTx(tx, {
        sessionId: params.sessionId,
        accountIds: params.mentionedAccountIds,
        authentication: params.authentication,
    });
    return params.mentionedAccountIds.every((accountId) => readable.has(accountId));
}

function scheduleDiscussionMentionRemoteAlertsInTx(tx: Tx, params: Readonly<{
    sessionId: string;
    discussionId: string;
    committedMessageSeq: number;
    authorAccountId: string;
    mentionedAccountIds: readonly string[];
    producer: SessionDiscussionProducerV1 | undefined;
}>): void {
    if (params.mentionedAccountIds.length === 0) return;
    afterTx(tx, () => scheduleSessionActivityRemoteAlerts({
        sessionId: params.sessionId,
        event: "discussion_mention",
        committedMessage: {
            domain: "discussion", discussionId: params.discussionId, seq: params.committedMessageSeq,
        },
        targetAccountIds: params.mentionedAccountIds,
        // A directly authenticated human never gets attention for their own
        // post, mention leg included. Agent posts stay eligible for the
        // execution Account exactly as the all-messages leg keeps them.
        ...(params.producer ? {} : { sourceAccountId: params.authorAccountId }),
    }));
}

function scheduleDiscussionMessageAlertsInTx(tx: Tx, params: Readonly<{
    sessionId: string;
    discussionId: string;
    committedMessageId: string;
    committedMessageSeq: number;
    recipientAccountIds: readonly string[];
    authorAccountId: string;
    mentionedAccountIds: readonly string[];
    producer: SessionDiscussionProducerV1 | undefined;
}>): void {
    const event = params.producer ? "message" : "human_message";
    for (const recipientAccountId of params.recipientAccountIds) {
        if (params.mentionedAccountIds.includes(recipientAccountId)) continue;
        const fact = {
            type: "session-personal-event" as const, sessionId: params.sessionId, eventId: params.committedMessageId,
            message: { sequenceDomain: "discussion" as const, discussionId: params.discussionId, messageSeq: params.committedMessageSeq },
        };
        scheduleSessionPersonalEvent(tx, recipientAccountId, event === "human_message"
            ? { ...fact, event, sourceAccountId: params.authorAccountId }
            : { ...fact, event });
    }
    afterTx(tx, () => scheduleSessionActivityRemoteAlerts({
        sessionId: params.sessionId,
        // Direct Account-authenticated posts are meaningful human activity and
        // therefore remain eligible for an Important Follow. Trusted runtime
        // posts use the ordinary all-messages class.
        event,
        committedMessage: {
            domain: "discussion", discussionId: params.discussionId, seq: params.committedMessageSeq,
        },
        // Only a directly authenticated human-authored post suppresses a self-alert.
        // Agent posts remain eligible for the execution Account's explicit
        // all-messages Follow like every other follower.
        ...(params.producer ? {} : { sourceAccountId: params.authorAccountId }),
        // A mention is the specific one-shot alert for this same committed row.
        excludeAccountIds: params.mentionedAccountIds,
    }));
}

async function insertMessageInTx(tx: Tx, params: Readonly<{
    sessionId: string;
    discussionId: string;
    authorAccountId: string;
    seq: number;
    intent: MessageIntent;
    producer: SessionDiscussionProducerV1 | undefined;
    createdAt: Date;
}>): Promise<SessionDiscussionMessageRow> {
    const message = await tx.sessionDiscussionMessage.create({
        data: {
            sessionId: params.sessionId,
            discussionId: params.discussionId,
            localId: params.intent.localId,
            requestEqualityEvidenceV1: params.intent.evidence,
            seq: params.seq,
            authorAccountId: params.authorAccountId,
            ...(params.producer ? { producerV1: params.producer } : {}),
            content: params.intent.content,
            createdAt: params.createdAt,
        },
        select: { id: true },
    });
    if (params.intent.mentionedAccountIds.length > 0) {
        await tx.sessionDiscussionMessageMention.createMany({
            data: params.intent.mentionedAccountIds.map((accountId) => ({
                messageId: message.id,
                accountId,
            })),
        });
    }
    return await readMessageRowInTx(tx, { messageId: message.id });
}

async function readMessageRowInTx(tx: Tx, params: Readonly<{ messageId: string }>): Promise<SessionDiscussionMessageRow> {
    const row = await tx.sessionDiscussionMessage.findUniqueOrThrow({
        where: { id: params.messageId },
        select: SESSION_DISCUSSION_MESSAGE_SELECT,
    });
    return row as SessionDiscussionMessageRow;
}

async function readMessageByLocalIdInTx(tx: Tx, params: Readonly<{
    discussionId: string;
    localId: string;
}>): Promise<SessionDiscussionMessageRow | null> {
    const row = await tx.sessionDiscussionMessage.findUnique({
        where: { discussionId_localId: { discussionId: params.discussionId, localId: params.localId } },
        select: { ...SESSION_DISCUSSION_MESSAGE_SELECT, requestEqualityEvidenceV1: true },
    });
    return (row as (SessionDiscussionMessageRow & { requestEqualityEvidenceV1: unknown }) | null) ?? null;
}

/**
 * Creates one discussion and its first message in a single transaction.
 *
 * There is deliberately no empty discussion, partial first message, or cleanup
 * timer: abandoning the composer leaves no row at all, and a lost response
 * reconciles through the creation identity rather than producing a second
 * discussion.
 */
async function createSessionDiscussionTransaction(
    params: CreateSessionDiscussionParams,
): Promise<SessionDiscussionResult<SessionDiscussionCreateResponseV1>> {
    return await inTx(async (tx) => {
        if (params.request.creationLocalId === params.request.firstMessage.localId) {
            return discussionFailure("session_discussion_invalid_content");
        }
        const context = await resolveSessionDiscussionContextInTx(tx, {
            sessionId: params.sessionId,
            accountId: params.actorAccountId,
            authentication: params.authentication,
        });
        if (!context) return discussionFailure("session_discussion_post_denied");

        const intent = resolveMessageIntent({
            context,
            localId: params.request.firstMessage.localId,
            content: params.request.firstMessage.content,
            mentionedAccountIds: params.request.firstMessage.mentionedAccountIds,
            suppliedEvidence: params.request.firstMessage.requestEqualityEvidenceV1,
        });
        if (isNormalizationFailure(intent)) return discussionFailure(intent.error);

        const creationEvidence = resolveCreationEvidence({
            context,
            titleContent: params.request.titleContent,
            firstMessage: intent,
            suppliedEvidence: params.request.creationEqualityEvidenceV1,
        });
        if (isNormalizationFailure(creationEvidence)) return discussionFailure(creationEvidence.error);

        const existing = await tx.sessionDiscussion.findUnique({
            where: {
                sessionId_creationLocalId: {
                    sessionId: params.sessionId,
                    creationLocalId: params.request.creationLocalId,
                },
            },
            select: { id: true, createdByAccountId: true, creationEqualityEvidenceV1: true },
        });
        if (existing) {
            // Rejoin binds the retry to its own non-erased creator as well as
            // equal evidence, so a caller-chosen local id can never adopt or
            // disclose another Account's result.
            if (existing.createdByAccountId !== params.actorAccountId
                || existing.createdByAccountId === null
                || !equalEvidence(existing.creationEqualityEvidenceV1, creationEvidence)) {
                return discussionFailure("session_discussion_idempotency_conflict");
            }
            const discussion = await readSessionDiscussionRowInTx(tx, {
                sessionId: params.sessionId,
                discussionId: existing.id,
            });
            const firstMessage = await readMessageByLocalIdInTx(tx, {
                discussionId: existing.id,
                localId: intent.localId,
            });
            const storedFirstMessageEvidence = firstMessage
                ? (firstMessage as { requestEqualityEvidenceV1?: unknown }).requestEqualityEvidenceV1
                : undefined;
            if (!discussion
                || !firstMessage
                || firstMessage.authorAccountId !== params.actorAccountId
                || firstMessage.authorAccountId === null
                || !equalEvidence(storedFirstMessageEvidence, intent.evidence)
                || !equalProducer(firstMessage.producerV1, undefined)) {
                return discussionFailure("session_discussion_idempotency_conflict");
            }
            const storedTitleFailure = validateSessionDiscussionStoredContent(
                discussion.titleContent,
                context.storageMode,
                "title",
            );
            if (storedTitleFailure) return discussionFailure(storedTitleFailure);
            const storedMessageFailure = validateSessionDiscussionStoredMessage(
                firstMessage,
                context.storageMode,
                params.sessionId,
            );
            if (storedMessageFailure) return discussionFailure(storedMessageFailure);
            return await projectCreateResponse(tx, {
                context,
                viewerAccountId: params.actorAccountId,
                discussion,
                firstMessage,
            });
        }

        if (!context.access.capabilities.submitAgentInput) {
            return discussionFailure("session_discussion_post_denied");
        }
        if (context.sessionArchived) return discussionFailure("session_discussion_session_archived");
        if (!await validateMentionTargetsInTx(tx, {
            sessionId: params.sessionId,
            mentionedAccountIds: intent.mentionedAccountIds,
            authentication: params.authentication,
        })) {
            return discussionFailure("session_discussion_invalid_mention");
        }

        const now = new Date();
        const created = await tx.sessionDiscussion.create({
            data: {
                sessionId: params.sessionId,
                creationLocalId: params.request.creationLocalId,
                creationEqualityEvidenceV1: creationEvidence,
                createdByAccountId: params.actorAccountId,
                titleContent: params.request.titleContent,
                messageSeq: 1,
                lastMessageAt: now,
            },
            select: { id: true },
        });
        const firstMessage = await insertMessageInTx(tx, {
            sessionId: params.sessionId,
            discussionId: created.id,
            authorAccountId: params.actorAccountId,
            seq: 1,
            intent,
            producer: undefined,
            createdAt: now,
        });
        await initializeNewSessionDiscussionCursorsInTx(tx, {
            sessionId: params.sessionId,
            discussionId: created.id,
            authentication: params.authentication,
        });
        const readerCursors = await markSessionDiscussionReadersChangedInTx({ tx, sessionId: params.sessionId });
        scheduleSessionDiscussionBadgeRefreshInTx({ tx, sessionId: params.sessionId });
        scheduleDiscussionMentionRemoteAlertsInTx(tx, {
            sessionId: params.sessionId,
            discussionId: created.id,
            committedMessageSeq: firstMessage.seq,
            authorAccountId: params.actorAccountId,
            mentionedAccountIds: intent.mentionedAccountIds,
            producer: undefined,
        });
        scheduleDiscussionMessageAlertsInTx(tx, {
            sessionId: params.sessionId,
            discussionId: created.id,
            committedMessageSeq: firstMessage.seq,
            committedMessageId: firstMessage.id,
            recipientAccountIds: readerCursors.map(({ accountId }) => accountId),
            authorAccountId: params.actorAccountId,
            mentionedAccountIds: intent.mentionedAccountIds,
            producer: undefined,
        });

        const discussion = await readSessionDiscussionRowInTx(tx, {
            sessionId: params.sessionId,
            discussionId: created.id,
        });
        if (!discussion) return discussionFailure("session_discussion_not_found");
        return await projectCreateResponse(tx, {
            context,
            viewerAccountId: params.actorAccountId,
            discussion,
            firstMessage,
        });
    }, { isolationLevel: "Serializable" /* Discussion lifecycle admission and tracking-entry cursor census must serialize with participating writers. */ });
}

export async function createSessionDiscussion(
    params: CreateSessionDiscussionParams,
): Promise<SessionDiscussionResult<SessionDiscussionCreateResponseV1>> {
    return await reconcileSessionDiscussionCreationIdentityRace(
        () => createSessionDiscussionTransaction(params),
    );
}

async function projectCreateResponse(tx: Tx, params: Readonly<{
    context: SessionDiscussionSessionContext;
    viewerAccountId: string;
    discussion: SessionDiscussionRow;
    firstMessage: SessionDiscussionMessageRow;
}>): Promise<SessionDiscussionResult<SessionDiscussionCreateResponseV1>> {
    const projected = await projectSessionDiscussionForViewerInTx(tx, {
        context: params.context,
        viewerAccountId: params.viewerAccountId,
        discussion: params.discussion,
    });
    if (!projected.ok) return projected;
    const [accountActor] = await projectAuthenticatedAccountActorsById(tx, [params.firstMessage.authorAccountId]);
    return discussionSuccess({
        discussion: projected.value,
        firstMessage: projectSessionDiscussionMessageV1(
            params.firstMessage,
            params.viewerAccountId,
            accountActor ?? null,
        ),
    });
}

/**
 * Agent provenance is decided here, once, for every carrier. A caller never
 * asserts it: the publisher socket supplies the richer run/tool-call form it
 * verified itself, and any other automation-authority post (the public
 * Action over a proof-bound PAT) is stamped with the default Agent producer.
 * A present-user post stays a direct human row.
 */
function resolveMessageProducer(params: Readonly<{
    sessionId: string;
    producer: SessionDiscussionProducerV1 | undefined;
    authority: "present_user" | "account_automation";
}>): SessionDiscussionProducerV1 | undefined {
    if (params.producer) return params.producer;
    return params.authority === "account_automation"
        ? { v: 1, kind: "agent", sessionId: params.sessionId }
        : undefined;
}

/**
 * Appends one authored message.
 *
 * The discussion-local sequence is allocated by an atomic increment inside the
 * same transaction that inserts the row, so concurrent posts receive unique
 * increasing numbers without a separate sequence table or a Session-wide lock.
 */
export async function postSessionDiscussionMessageInTx(tx: Tx, params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    discussionId: string;
    request: SessionDiscussionPostRequestV1;
    producer?: SessionDiscussionProducerV1;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<SessionDiscussionResult<SessionDiscussionPostResponseV1>> {
        const context = await resolveSessionDiscussionContextInTx(tx, {
            sessionId: params.sessionId,
            accountId: params.actorAccountId,
            authentication: params.authentication,
        });
        if (!context) return discussionFailure("session_discussion_post_denied");
        const discussion = await readSessionDiscussionRowInTx(tx, params);
        if (!discussion) return discussionFailure("session_discussion_not_found");

        const producer = resolveMessageProducer({
            sessionId: params.sessionId,
            producer: params.producer,
            authority: params.authentication.authority,
        });
        if (!isValidProducerForSession(producer, params.sessionId)) {
            return discussionFailure("session_discussion_invalid_content");
        }

        const intent = resolveMessageIntent({
            context,
            localId: params.request.localId,
            content: params.request.content,
            mentionedAccountIds: params.request.mentionedAccountIds,
            suppliedEvidence: params.request.requestEqualityEvidenceV1,
        });
        if (isNormalizationFailure(intent)) return discussionFailure(intent.error);

        const existing = await readMessageByLocalIdInTx(tx, {
            discussionId: discussion.id,
            localId: intent.localId,
        });
        if (existing) {
            const storedEvidence = (existing as { requestEqualityEvidenceV1?: unknown }).requestEqualityEvidenceV1;
            // A valid same-author duplicate rejoins even after the discussion or
            // Session was archived: the original write already committed.
            if (existing.authorAccountId !== params.actorAccountId
                || existing.authorAccountId === null
                || !equalEvidence(storedEvidence, intent.evidence)
                || !equalProducer(existing.producerV1, producer)) {
                return discussionFailure("session_discussion_idempotency_conflict");
            }
            const storedContentFailure = validateSessionDiscussionStoredMessage(
                existing,
                context.storageMode,
                params.sessionId,
            );
            if (storedContentFailure) return discussionFailure(storedContentFailure);
            const [accountActor] = await projectAuthenticatedAccountActorsById(tx, [existing.authorAccountId]);
            return discussionSuccess({
                message: projectSessionDiscussionMessageV1(existing, params.actorAccountId, accountActor ?? null),
                messageSeq: discussion.messageSeq,
            });
        }

        if (!context.access.capabilities.submitAgentInput) {
            return discussionFailure("session_discussion_post_denied");
        }
        if (context.sessionArchived) return discussionFailure("session_discussion_session_archived");
        if (discussion.archivedAt !== null) return discussionFailure("session_discussion_archived");
        if (!await validateMentionTargetsInTx(tx, {
            sessionId: params.sessionId,
            mentionedAccountIds: intent.mentionedAccountIds,
            authentication: params.authentication,
        })) {
            return discussionFailure("session_discussion_invalid_mention");
        }

        const now = new Date();
        const allocated = await tx.sessionDiscussion.update({
            where: { id: discussion.id },
            data: { messageSeq: { increment: 1 }, lastMessageAt: now },
            select: { messageSeq: true },
        });
        const message = await insertMessageInTx(tx, {
            sessionId: params.sessionId,
            discussionId: discussion.id,
            authorAccountId: params.actorAccountId,
            seq: allocated.messageSeq,
            intent,
            producer,
            createdAt: now,
        });
        const readerCursors = await markSessionDiscussionReadersChangedInTx({ tx, sessionId: params.sessionId });
        scheduleSessionDiscussionBadgeRefreshInTx({ tx, sessionId: params.sessionId });
        scheduleDiscussionMentionRemoteAlertsInTx(tx, {
            sessionId: params.sessionId,
            discussionId: discussion.id,
            committedMessageSeq: allocated.messageSeq,
            authorAccountId: params.actorAccountId,
            mentionedAccountIds: intent.mentionedAccountIds,
            producer,
        });
        scheduleDiscussionMessageAlertsInTx(tx, {
            sessionId: params.sessionId,
            discussionId: discussion.id,
            committedMessageSeq: allocated.messageSeq,
            committedMessageId: message.id,
            recipientAccountIds: readerCursors.map(({ accountId }) => accountId),
            authorAccountId: params.actorAccountId,
            mentionedAccountIds: intent.mentionedAccountIds,
            producer,
        });
        const [accountActor] = await projectAuthenticatedAccountActorsById(tx, [message.authorAccountId]);

        return discussionSuccess({
            message: projectSessionDiscussionMessageV1(message, params.actorAccountId, accountActor ?? null),
            messageSeq: allocated.messageSeq,
        });
}

export async function postSessionDiscussionMessage(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    discussionId: string;
    request: SessionDiscussionPostRequestV1;
    producer?: SessionDiscussionProducerV1;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<SessionDiscussionResult<SessionDiscussionPostResponseV1>> {
    return await inTx(async (tx) => await postSessionDiscussionMessageInTx(tx, params), { isolationLevel: "Serializable" /* Discussion lifecycle admission and tracking-entry cursor census must serialize with participating writers. */ });
}

type DiscussionManagementIntent = "rename" | "archive" | "restore";

async function resolveManagementTargetInTx(tx: Tx, params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    discussionId: string;
    intent: DiscussionManagementIntent;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<
    | Readonly<{ ok: true; context: SessionDiscussionSessionContext; discussion: SessionDiscussionRow }>
    | Readonly<{ ok: false; result: SessionDiscussionResult<never> }>
> {
    const context = await resolveSessionDiscussionContextInTx(tx, {
        sessionId: params.sessionId,
        accountId: params.actorAccountId,
        authentication: params.authentication,
    });
    if (!context) return { ok: false, result: discussionFailure("session_discussion_not_found") };
    const discussion = await readSessionDiscussionRowInTx(tx, params);
    if (!discussion) return { ok: false, result: discussionFailure("session_discussion_not_found") };

    // Restore is a pure management capability. Rename and archive additionally
    // accept the discussion's own creator with current input access, which is a
    // discussion-domain rule rather than a new Session capability.
    const allowed = params.intent === "restore"
        ? context.access.capabilities.manageAccess
        : context.access.capabilities.manageAccess
            || (discussion.createdByAccountId === params.actorAccountId
                && context.access.capabilities.submitAgentInput);
    if (!allowed) return { ok: false, result: discussionFailure("session_discussion_manage_denied") };
    if (context.sessionArchived) {
        return { ok: false, result: discussionFailure("session_discussion_session_archived") };
    }
    if (params.intent === "rename" && discussion.archivedAt !== null) {
        return { ok: false, result: discussionFailure("session_discussion_archived") };
    }
    return { ok: true, context, discussion };
}

async function projectDetailsAfterManagementInTx(tx: Tx, params: Readonly<{
    context: SessionDiscussionSessionContext;
    viewerAccountId: string;
    sessionId: string;
    discussionId: string;
}>): Promise<SessionDiscussionResult<SessionDiscussionDetailsResponseV1>> {
    const discussion = await readSessionDiscussionRowInTx(tx, params);
    if (!discussion) return discussionFailure("session_discussion_not_found");
    const storedTitleFailure = validateSessionDiscussionStoredContent(
        discussion.titleContent,
        params.context.storageMode,
        "title",
    );
    if (storedTitleFailure) return discussionFailure(storedTitleFailure);
    const projected = await projectSessionDiscussionForViewerInTx(tx, {
        context: params.context,
        viewerAccountId: params.viewerAccountId,
        discussion,
    });
    if (!projected.ok) return projected;
    return discussionSuccess({ discussion: projected.value });
}

/** A title edit never reorders the Collaboration list: `lastMessageAt` is message activity. */
export async function renameSessionDiscussion(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    discussionId: string;
    titleContent: StrictSessionStoredMessageContentEnvelope;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<SessionDiscussionResult<SessionDiscussionDetailsResponseV1>> {
    return await inTx(async (tx) => {
        const target = await resolveManagementTargetInTx(tx, { ...params, intent: "rename" });
        if (!target.ok) return target.result;
        if (!matchesStorageMode(params.titleContent, target.context)) {
            return discussionFailure("session_discussion_encryption_mode_mismatch");
        }
        if (params.titleContent.t === "plain"
            && !SessionDiscussionTitleV1Schema.safeParse(params.titleContent.v).success) {
            return discussionFailure("session_discussion_invalid_content");
        }
        await tx.sessionDiscussion.update({
            where: { id: target.discussion.id },
            data: { titleContent: params.titleContent },
            select: { id: true },
        });
        await markSessionDiscussionReadersChangedInTx({ tx, sessionId: params.sessionId });
        return await projectDetailsAfterManagementInTx(tx, {
            context: target.context,
            viewerAccountId: params.actorAccountId,
            sessionId: params.sessionId,
            discussionId: params.discussionId,
        });
    }, { isolationLevel: "Serializable" /* Discussion lifecycle admission and tracking-entry cursor census must serialize with participating writers. */ });
}

/** Archiving is reversible and keeps history readable; there is no hard delete. */
export async function archiveSessionDiscussion(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    discussionId: string;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<SessionDiscussionResult<SessionDiscussionDetailsResponseV1>> {
    return await inTx(async (tx) => {
        const target = await resolveManagementTargetInTx(tx, { ...params, intent: "archive" });
        if (!target.ok) return target.result;
        if (target.discussion.archivedAt === null) {
            await tx.sessionDiscussion.update({
                where: { id: target.discussion.id },
                data: { archivedAt: new Date() },
                select: { id: true },
            });
            await markSessionDiscussionReadersChangedInTx({ tx, sessionId: params.sessionId });
            scheduleSessionDiscussionBadgeRefreshInTx({ tx, sessionId: params.sessionId });
        }
        return await projectDetailsAfterManagementInTx(tx, {
            context: target.context,
            viewerAccountId: params.actorAccountId,
            sessionId: params.sessionId,
            discussionId: params.discussionId,
        });
    }, { isolationLevel: "Serializable" /* Discussion lifecycle admission and tracking-entry cursor census must serialize with participating writers. */ });
}

export async function restoreSessionDiscussion(params: Readonly<{
    actorAccountId: string;
    sessionId: string;
    discussionId: string;
    authentication: import("@/app/session/access/sessionAccessAuthentication").SessionAccessAuthentication;
}>): Promise<SessionDiscussionResult<SessionDiscussionDetailsResponseV1>> {
    return await inTx(async (tx) => {
        const target = await resolveManagementTargetInTx(tx, { ...params, intent: "restore" });
        if (!target.ok) return target.result;
        if (target.discussion.archivedAt !== null) {
            await tx.sessionDiscussion.update({
                where: { id: target.discussion.id },
                data: { archivedAt: null },
                select: { id: true },
            });
            await markSessionDiscussionReadersChangedInTx({ tx, sessionId: params.sessionId });
            scheduleSessionDiscussionBadgeRefreshInTx({ tx, sessionId: params.sessionId });
        }
        return await projectDetailsAfterManagementInTx(tx, {
            context: target.context,
            viewerAccountId: params.actorAccountId,
            sessionId: params.sessionId,
            discussionId: params.discussionId,
        });
    }, { isolationLevel: "Serializable" /* Discussion lifecycle admission and tracking-entry cursor census must serialize with participating writers. */ });
}
