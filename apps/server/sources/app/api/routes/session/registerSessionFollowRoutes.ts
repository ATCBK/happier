import { GetSessionFollowResponseSchema, SetSessionFollowRequestSchema, SetSessionFollowResponseSchema, RemoveSessionFollowResponseSchema, SessionFollowErrorResponseSchema, ReplaceSessionVoiceInclusionsRequestSchema, ReplaceSessionVoiceInclusionsResponseSchema } from '@happier-dev/protocol/sessions/follow/api';
import { SessionAutoFollowPreferencesV1Schema } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { z } from "zod";

import { createServerFeatureGatePreHandler } from "@/app/features/catalog/serverFeatureGate";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import {
    getAccountSessionFollow, setAccountSessionFollow, removeAccountSessionFollow,
    getSessionAutoFollowPreferences, setSessionAutoFollowPreferences,
    replaceAccountSessionVoiceInclusions,
    type AccountFollowFailure,
} from "@/app/session/follow/accountFollowService";
import type { Fastify } from "../../types";
import { AccountRouteAuthenticationForbiddenResponseSchema } from "@/app/api/utils/enableAuthentication";

const paramsSchema = z.object({ sessionId: z.string().min(1) }).strict();
const FAILURE_STATUS: Readonly<Record<AccountFollowFailure, 400 | 403 | 404 | 409>> = {
    invalid_parameters: 400, account_inactive: 403, session_not_found: 404, session_archived: 409,
};
const errorResponses = {
    400: SessionFollowErrorResponseSchema,
    403: z.union([SessionFollowErrorResponseSchema, AccountRouteAuthenticationForbiddenResponseSchema]),
    404: SessionFollowErrorResponseSchema, 409: SessionFollowErrorResponseSchema,
};

/** Authenticated human preference transport; domain admission and writes stay in the Follow owner. */
export function registerSessionFollowRoutes(app: Fastify) {
    const requireFeature = createServerFeatureGatePreHandler(
        "sessions.following",
        process.env,
        { error: "feature_unavailable" },
    );
    app.get("/v2/sessions/:sessionId/follow", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true, apiTokenSessionAction: 'session.follow.get',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: { params: paramsSchema, response: { 200: GetSessionFollowResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const result = await getAccountSessionFollow({ accountId: request.userId, sessionId: request.params.sessionId, authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.put("/v2/sessions/:sessionId/follow", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true, apiTokenSessionAction: 'session.follow.set',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: { params: paramsSchema, response: { 200: SetSessionFollowResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const body = SetSessionFollowRequestSchema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: "invalid_parameters" });
        const result = await setAccountSessionFollow({ accountId: request.userId, sessionId: request.params.sessionId, preferences: body.data, authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.delete("/v2/sessions/:sessionId/follow", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true, apiTokenSessionAction: 'session.follow.remove',
            restrictedCredentialBinding: { scope: 'session', session: 'params.sessionId', allowSessionRuntime: false } },
        schema: { params: paramsSchema, response: { 200: RemoveSessionFollowResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const result = await removeAccountSessionFollow({ accountId: request.userId, sessionId: request.params.sessionId, authentication: readSessionAccessAuthenticationFromRequest(request) });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.get("/v2/account/session-follow-preferences", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true },
        schema: { response: { 200: SessionAutoFollowPreferencesV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        const result = await getSessionAutoFollowPreferences({ accountId: request.userId });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.put("/v2/account/session-follow-preferences", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true },
        schema: { response: { 200: SessionAutoFollowPreferencesV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        const body = SessionAutoFollowPreferencesV1Schema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: "invalid_parameters" });
        const result = await setSessionAutoFollowPreferences({ accountId: request.userId, preferences: body.data });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
    app.put("/v2/account/session-follow-voice-inclusions", { preHandler: [app.authenticate, requireFeature],
        config: { allowApiToken: true },
        schema: { response: { 200: ReplaceSessionVoiceInclusionsResponseSchema, ...errorResponses } },
    }, async (request, reply) => {
        const body = ReplaceSessionVoiceInclusionsRequestSchema.safeParse(request.body);
        if (!body.success) return reply.code(400).send({ error: "invalid_parameters" });
        const result = await replaceAccountSessionVoiceInclusions({
            accountId: request.userId,
            sessionIds: body.data.sessionIds,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        return result.ok ? reply.send(result.value) : reply.code(FAILURE_STATUS[result.error]).send({ error: result.error });
    });
}
