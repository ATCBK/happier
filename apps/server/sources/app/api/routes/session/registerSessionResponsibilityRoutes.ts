import { z } from "zod/mini";

import { SESSION_RESPONSIBILITY_ASSIGNEE_UNAVAILABLE_V1, SESSION_RESPONSIBILITY_CANDIDATES_INVALID_CURSOR_V1, SessionResponsibilityCandidatesRequestSchema, SessionResponsibilityCandidatesResponseSchema, SetSessionResponsibilityRequestSchema, SetSessionResponsibilityResponseSchema } from '@happier-dev/protocol/sessions/access/sessionResponsibilityV1';
import {
    listSessionResponsibilityCandidates,
    setSessionResponsibility,
} from "@/app/session/access/sessionResponsibilityService";
import { type Fastify } from "../../types";
import { createServerFeatureGatedRouteApp } from "@/app/features/catalog/serverFeatureGate";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { NotFoundSchema as FeatureUnavailableSchema } from "../../schemas/notFoundSchema";
import { AccountRouteAuthenticationForbiddenResponseSchema } from "@/app/api/utils/enableAuthentication";

const ForbiddenSchema = z.object({ error: z.literal("session_access_forbidden") });
const AuthenticationRequiredSchema = z.object({ error: z.literal("session_access_authentication_required") });
const AuthenticationUnavailableSchema = z.object({ error: z.literal("session_access_authentication_unavailable") });
const NotFoundSchema = z.union([
    z.object({ error: z.literal("session_access_session_not_found") }),
    FeatureUnavailableSchema,
]);
const AssigneeUnavailableSchema = z.object({
    error: z.literal(SESSION_RESPONSIBILITY_ASSIGNEE_UNAVAILABLE_V1),
});
const InvalidCursorSchema = z.object({
    error: z.literal(SESSION_RESPONSIBILITY_CANDIDATES_INVALID_CURSOR_V1),
});

/**
 * The one transport for the responsible-assignment desired state and for the
 * bounded principal discovery that feeds its picker.
 *
 * `set` is a desired-state operation despite its POST carrier: submitting the
 * current value again is a true no-op, so a retry after a lost response is safe.
 */
export function registerSessionResponsibilityRoutes(app: Fastify) {
    const collaborationApp = createServerFeatureGatedRouteApp(app, "sharing.session");
    collaborationApp.post("/v2/sessions/responsibility/set", {
        preHandler: app.authenticate,
        config: { apiTokenSessionAction: 'session.responsibility.set',
            restrictedCredentialBinding: { scope: 'session', session: 'body.sessionId', allowSessionRuntime: false } },
        schema: {
            body: SetSessionResponsibilityRequestSchema,
            response: {
                200: SetSessionResponsibilityResponseSchema,
                403: z.union([ForbiddenSchema, AuthenticationRequiredSchema, AccountRouteAuthenticationForbiddenResponseSchema]),
                404: NotFoundSchema,
                409: AssigneeUnavailableSchema,
                503: AuthenticationUnavailableSchema,
            },
        },
    }, async (request, reply) => {
        const result = await setSessionResponsibility({
            actorAccountId: request.userId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            sessionId: request.body.sessionId,
            responsibleAccountId: request.body.responsibleAccountId,
        });

        if (!result.ok) {
            if (result.error === "session_access_authentication_required") {
                return reply.code(403).send({ error: result.error });
            }
            if (result.error === "session_access_authentication_unavailable") {
                return reply.code(503).send({ error: result.error });
            }
            if (result.error === "forbidden") return reply.code(403).send({ error: "session_access_forbidden" });
            if (result.error === "not_found") return reply.code(404).send({ error: "session_access_session_not_found" });
            return reply.code(409).send({ error: SESSION_RESPONSIBILITY_ASSIGNEE_UNAVAILABLE_V1 });
        }

        return reply.send({
            changed: result.changed,
            responsibleAccountId: result.responsibleAccountId,
            responsibleAccount: result.responsibleAccount,
            autoFollowed: result.autoFollowed,
        });
    });

    collaborationApp.post("/v2/sessions/responsibility/candidates", {
        preHandler: app.authenticate,
        config: { apiTokenSessionAction: 'session.responsibility.candidates.list',
            restrictedCredentialBinding: { scope: 'session', session: 'body.sessionId', allowSessionRuntime: false } },
        schema: {
            body: SessionResponsibilityCandidatesRequestSchema,
            response: {
                200: SessionResponsibilityCandidatesResponseSchema,
                400: InvalidCursorSchema,
                403: z.union([ForbiddenSchema, AuthenticationRequiredSchema, AccountRouteAuthenticationForbiddenResponseSchema]),
                404: NotFoundSchema,
                503: AuthenticationUnavailableSchema,
            },
        },
    }, async (request, reply) => {
        const result = await listSessionResponsibilityCandidates({
            actorAccountId: request.userId,
            authentication: readSessionAccessAuthenticationFromRequest(request),
            sessionId: request.body.sessionId,
            purpose: request.body.purpose,
            ...(request.body.query === undefined ? {} : { query: request.body.query }),
            ...(request.body.cursor === undefined ? {} : { cursor: request.body.cursor }),
            ...(request.body.limit === undefined ? {} : { limit: request.body.limit }),
        });

        if (!result.ok) {
            if (result.error === "invalid_cursor") {
                return reply.code(400).send({ error: SESSION_RESPONSIBILITY_CANDIDATES_INVALID_CURSOR_V1 });
            }
            if (result.error === "session_access_authentication_required") {
                return reply.code(403).send({ error: result.error });
            }
            if (result.error === "session_access_authentication_unavailable") {
                return reply.code(503).send({ error: result.error });
            }
            if (result.error === "forbidden") return reply.code(403).send({ error: "session_access_forbidden" });
            return reply.code(404).send({ error: "session_access_session_not_found" });
        }

        return reply.send({ candidates: [...result.candidates], nextCursor: result.nextCursor });
    });
}
