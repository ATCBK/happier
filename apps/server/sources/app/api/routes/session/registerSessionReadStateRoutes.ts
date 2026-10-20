import { z } from "zod/mini";
import { SESSION_READ_STATE_HTTP_PATHS_V1, SessionReadStateRouteRequestBodyV1Schema, SessionReadStateRouteSuccessResponseV1Schema, SessionReadStateRouteInvalidRequestResponseV1Schema, SessionReadStateRouteForbiddenResponseV1Schema, SessionReadStateRouteNotTrackedResponseV1Schema, SessionReadStateRouteNotFoundResponseV1Schema, SessionReadStateRouteFailureResponseV1Schema } from '@happier-dev/protocol/sessions';

import { publishSessionReadCursorUpdate } from "@/app/session/readCursor/publishSessionReadCursorUpdate";
import { applySessionReadCursorOperation } from "@/app/session/sessionWriteService";
import { loadSessionViewerProjection } from "@/app/session/personal/projection";
import { type Fastify } from "../../types";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { requireRouteActionAuthority } from "@/app/api/utils/requireRouteActionAuthority";
import { AccountRouteAuthenticationForbiddenResponseSchema } from "@/app/api/utils/enableAuthentication";

export function registerSessionReadStateRoutes(app: Fastify) {
    app.post(SESSION_READ_STATE_HTTP_PATHS_V1.set, {
        preHandler: [app.authenticate, requireRouteActionAuthority("session.read_state.set")],
        config: { apiTokenSessionAction: 'session.read_state.set',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: SessionReadStateRouteRequestBodyV1Schema,
            response: {
                200: SessionReadStateRouteSuccessResponseV1Schema,
                400: SessionReadStateRouteInvalidRequestResponseV1Schema,
                403: z.union([SessionReadStateRouteForbiddenResponseV1Schema, AccountRouteAuthenticationForbiddenResponseSchema]),
                409: SessionReadStateRouteNotTrackedResponseV1Schema,
                404: SessionReadStateRouteNotFoundResponseV1Schema,
                500: SessionReadStateRouteFailureResponseV1Schema,
            },
        },
    }, async (request, reply) => {
        const parsedBody = SessionReadStateRouteRequestBodyV1Schema.safeParse(request.body);
        if (!parsedBody.success) {
            return reply.code(400).send({ error: "invalid-read-state" });
        }

        const userId = request.userId;
        const { sessionId } = request.params;
        const state = parsedBody.data.state;

        const result = await applySessionReadCursorOperation({
            actorUserId: userId,
            sessionId,
            operation: state === "read" ? { kind: "mark-read" } : { kind: "mark-unread" },
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });

        if (!result.ok) {
            if (result.error === "invalid-params") return reply.code(400).send({ error: "invalid-read-state" });
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-tracked") {
                const viewer = await loadSessionViewerProjection({ accountId: userId, sessionId, authentication: readSessionAccessAuthenticationFromRequest(request) });
                return reply.code(409).send({ error: "session_not_tracked", ...(viewer ? { viewer } : {}) });
            }
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to update session read state" });
        }

        const viewer = await publishSessionReadCursorUpdate({
            sessionId,
            ...result,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });

        return reply.send({
            success: true as const,
            state: result.readState,
            lastViewedSessionSeq: result.lastViewedSessionSeq,
            didChange: result.didChange,
            ...(viewer ? { viewer } : {}),
        });
    });
}
