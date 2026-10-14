import { SESSION_DISCUSSION_HTTP_PATHS_V1, SESSION_DISCUSSION_NOT_TRACKED_CODE_V1, SessionDiscussionCreateRequestV1Schema, SessionDiscussionCreateResponseV1Schema, SessionDiscussionDetailsResponseV1Schema, SessionDiscussionErrorResponseV1Schema, SessionDiscussionListQueryV1Schema, SessionDiscussionListResponseV1Schema, SessionDiscussionMessagesQueryV1Schema, SessionDiscussionMessagesResponseV1Schema, SessionDiscussionPostRequestV1Schema, SessionDiscussionPostResponseV1Schema, SessionDiscussionReadRequestV1Schema, SessionDiscussionReadResponseV1Schema, SessionDiscussionRenameRequestV1Schema, SessionDiscussionRouteDiscussionParamsV1Schema, SessionDiscussionRouteParamsV1Schema, isSessionDiscussionRequestWithinTransportBudgetV1 } from '@happier-dev/protocol/sessions/discussions/api';

import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import {
    PresentUserRequiredResponseSchema,
} from "@/app/api/utils/requirePresentUser";
import { requireRouteActionAuthority } from "@/app/api/utils/requireRouteActionAuthority";
import {
    archiveSessionDiscussion,
    createSessionDiscussion,
    postSessionDiscussionMessage,
    renameSessionDiscussion,
    restoreSessionDiscussion,
} from "@/app/session/discussions/mutations";
import {
    getSessionDiscussion,
    listSessionDiscussions,
    readSessionDiscussionMessages,
} from "@/app/session/discussions/queries";
import { setSessionDiscussionReadCursor } from "@/app/session/discussions/readState";
import type { SessionDiscussionFailureCode } from "@/app/session/discussions/serviceTypes";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { type Fastify } from "../../types";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";

/**
 * The typed result → HTTP mapping.
 *
 * Denial and absence deliberately collapse to 404 for a named discussion so a
 * probe cannot confirm that one exists in a Session the caller cannot read. The
 * service decides which of the two it returns; the route never re-derives it.
 */
type SessionDiscussionFailureStatus = 400 | 403 | 404 | 409;

function statusForDiscussionFailure(error: SessionDiscussionFailureCode): SessionDiscussionFailureStatus {
    switch (error) {
        case "session_discussions_unavailable":
            return 404;
        case "session_discussion_not_found":
        case "session_discussion_read_denied":
            return 404;
        case "session_discussion_post_denied":
        case "session_discussion_manage_denied":
            return 403;
        case "session_discussion_archived":
        case "session_discussion_session_archived":
        case "session_discussion_idempotency_conflict":
        case SESSION_DISCUSSION_NOT_TRACKED_CODE_V1:
            return 409;
        default:
            return 400;
    }
}

/**
 * A rejected request body, parameter or query is a caller-visible discussion
 * failure, not a transport crash.
 *
 * The strict Protocol schemas are what keep a public caller from asserting
 * host-stamped Agent provenance or malformed stored content, so their rejection
 * must arrive as this family's own typed 400. Fastify's generic validation body
 * cannot be serialized by the declared error union and would otherwise surface
 * as an opaque 500, hiding exactly the refusal the client needs to see.
 */
function sessionDiscussionRouteErrorHandler(
    error: FastifyError,
    _request: FastifyRequest,
    reply: FastifyReply,
): unknown {
    if (error.validation) {
        return reply.code(400).send({ error: "session_discussion_invalid_content" });
    }
    return reply.send(error);
}

const DiscussionErrorResponses = {
    400: SessionDiscussionErrorResponseV1Schema,
    403: SessionDiscussionErrorResponseV1Schema,
    404: SessionDiscussionErrorResponseV1Schema,
    409: SessionDiscussionErrorResponseV1Schema,
} as const;

const PresentUserDiscussionErrorResponses = {
    ...DiscussionErrorResponses,
    403: z.union([SessionDiscussionErrorResponseV1Schema, PresentUserRequiredResponseSchema]),
} as const;

/**
 * Session-owned human discussion transport.
 *
 * Every route authenticates, feature-gates, parses the Protocol schema and calls
 * exactly one service function. Authorization, encryption-mode enforcement,
 * sequence allocation, idempotency and invalidation all live at that service; a
 * route never re-implements or relaxes them.
 */
export function registerSessionDiscussionRoutes(app: Fastify) {
    const discussionsApp = createServerFeatureGatedRouteApp(
        app,
        "sessions.conversations",
        process.env,
        // The declared error union is the family's only response vocabulary, so
        // the shared gate refuses with the code this family already maps to 404
        // rather than a body its own 404 schema cannot serialize.
        { error: "session_discussions_unavailable" },
    );
    const rateLimit = resolveApiHotEndpointRateLimit(process.env, "session.discussions");

    discussionsApp.get(SESSION_DISCUSSION_HTTP_PATHS_V1.collection, {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            rateLimit,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
        errorHandler: sessionDiscussionRouteErrorHandler,
        schema: {
            params: SessionDiscussionRouteParamsV1Schema,
            querystring: SessionDiscussionListQueryV1Schema,
            response: { 200: SessionDiscussionListResponseV1Schema, ...DiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await listSessionDiscussions({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            ...(request.query.state === undefined ? {} : { state: request.query.state }),
            ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
            ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.post(SESSION_DISCUSSION_HTTP_PATHS_V1.collection, {
        preHandler: [app.authenticate, requireRouteActionAuthority("session.discussion.create")],
        config: { rateLimit },
        errorHandler: sessionDiscussionRouteErrorHandler,
        schema: {
            params: SessionDiscussionRouteParamsV1Schema,
            body: SessionDiscussionCreateRequestV1Schema,
            response: { 200: SessionDiscussionCreateResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        if (!isSessionDiscussionRequestWithinTransportBudgetV1(request.body)) {
            return reply.code(400).send({ error: "session_discussion_invalid_content" });
        }
        const result = await createSessionDiscussion({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            request: request.body,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.get(SESSION_DISCUSSION_HTTP_PATHS_V1.discussion, {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            rateLimit,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
        errorHandler: sessionDiscussionRouteErrorHandler,
        schema: {
            params: SessionDiscussionRouteDiscussionParamsV1Schema,
            response: { 200: SessionDiscussionDetailsResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await getSessionDiscussion({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            discussionId: request.params.discussionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.patch(SESSION_DISCUSSION_HTTP_PATHS_V1.discussion, {
        preHandler: [app.authenticate, requireRouteActionAuthority("session.discussion.rename")],
        config: { rateLimit },
        errorHandler: sessionDiscussionRouteErrorHandler,
        schema: {
            params: SessionDiscussionRouteDiscussionParamsV1Schema,
            body: SessionDiscussionRenameRequestV1Schema,
            response: { 200: SessionDiscussionDetailsResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        if (!isSessionDiscussionRequestWithinTransportBudgetV1(request.body)) {
            return reply.code(400).send({ error: "session_discussion_invalid_content" });
        }
        const result = await renameSessionDiscussion({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            discussionId: request.params.discussionId,
            titleContent: request.body.titleContent,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.post(SESSION_DISCUSSION_HTTP_PATHS_V1.archive, {
        preHandler: [app.authenticate, requireRouteActionAuthority("session.discussion.archive")],
        config: { rateLimit },
        errorHandler: sessionDiscussionRouteErrorHandler,
        schema: {
            params: SessionDiscussionRouteDiscussionParamsV1Schema,
            response: { 200: SessionDiscussionDetailsResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await archiveSessionDiscussion({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            discussionId: request.params.discussionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.post(SESSION_DISCUSSION_HTTP_PATHS_V1.restore, {
        preHandler: [app.authenticate, requireRouteActionAuthority("session.discussion.restore")],
        config: { rateLimit },
        errorHandler: sessionDiscussionRouteErrorHandler,
        schema: {
            params: SessionDiscussionRouteDiscussionParamsV1Schema,
            response: { 200: SessionDiscussionDetailsResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await restoreSessionDiscussion({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            discussionId: request.params.discussionId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.get(SESSION_DISCUSSION_HTTP_PATHS_V1.messages, {
        preHandler: app.authenticate,
        config: {
            allowApiToken: true,
            rateLimit,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
        errorHandler: sessionDiscussionRouteErrorHandler,
        schema: {
            params: SessionDiscussionRouteDiscussionParamsV1Schema,
            querystring: SessionDiscussionMessagesQueryV1Schema,
            response: { 200: SessionDiscussionMessagesResponseV1Schema, ...DiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await readSessionDiscussionMessages({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            discussionId: request.params.discussionId,
            ...(request.query.beforeSeq === undefined ? {} : { beforeSeq: request.query.beforeSeq }),
            ...(request.query.afterSeq === undefined ? {} : { afterSeq: request.query.afterSeq }),
            ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.post(SESSION_DISCUSSION_HTTP_PATHS_V1.messages, {
        preHandler: [app.authenticate, requireRouteActionAuthority("session.discussion.post")],
        config: {
            rateLimit,
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
        },
        errorHandler: sessionDiscussionRouteErrorHandler,
        schema: {
            params: SessionDiscussionRouteDiscussionParamsV1Schema,
            body: SessionDiscussionPostRequestV1Schema,
            response: { 200: SessionDiscussionPostResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        // Authorship is the authenticated Account. The strict public body has
        // no producer field and this public route never accepts descriptive
        // Agent provenance from its caller; the writer derives it from the
        // verified request authority it already receives.
        if (!isSessionDiscussionRequestWithinTransportBudgetV1(request.body)) {
            return reply.code(400).send({ error: "session_discussion_invalid_content" });
        }
        const result = await postSessionDiscussionMessage({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            discussionId: request.params.discussionId,
            request: request.body,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });

    discussionsApp.put(SESSION_DISCUSSION_HTTP_PATHS_V1.read, {
        preHandler: [app.authenticate, requireRouteActionAuthority("session.discussion.read_state.set")],
        config: { rateLimit },
        errorHandler: sessionDiscussionRouteErrorHandler,
        schema: {
            params: SessionDiscussionRouteDiscussionParamsV1Schema,
            body: SessionDiscussionReadRequestV1Schema,
            response: { 200: SessionDiscussionReadResponseV1Schema, ...PresentUserDiscussionErrorResponses },
        },
    }, async (request, reply) => {
        const result = await setSessionDiscussionReadCursor({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            discussionId: request.params.discussionId,
            lastReadSeq: request.body.lastReadSeq,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForDiscussionFailure(result.error)).send({ error: result.error });
        return reply.send(result.value);
    });
}
