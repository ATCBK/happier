import { z } from "zod/mini";

import { decodeSessionDataKeyEnvelopeCursorV1, PatchSessionDataKeyEnvelopesResultV1Schema, PatchSessionDataKeyEnvelopesV1Schema, SessionDataKeyEnvelopePageQueryV1Schema, SessionDataKeyEnvelopePageV1Schema } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';

import {
    applySessionDataKeyEnvelopes,
    readSessionDataKeyEnvelopePage,
    type SessionDataKeyEnvelopePageError,
    type SessionDataKeyEnvelopePatchError,
} from "@/app/session/encryption/sessionDataKeyEnvelopeService";
import { type Fastify } from "../../types";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { AccountRouteAuthenticationForbiddenResponseSchema } from "@/app/api/utils/enableAuthentication";

/**
 * Transport for the per-Session recipient envelope collection.
 *
 * The module is deliberately thin: it parses the boundary, maps the service's
 * stable error code to a status, and returns the projection. Concealment,
 * capability, recipient readiness and envelope structure all stay with the
 * canonical service so no second answer can be given here.
 *
 * The collection is not feature gated. It is the one envelope owner for every
 * access kind, including plain direct sharing and owner repair, and the access
 * owner already withholds Team and Group audiences when collaboration is off;
 * gating the transport would instead break direct-share preparation.
 */

const errorSchema = <Code extends z.ZodMiniType>(code: Code) => z.strictObject({ error: code });
const InvalidRequestErrorSchema = errorSchema(z.literal("invalid_request"));
const PageBadRequestErrorSchema = errorSchema(z.enum(["invalid_request", "invalid_cursor"]));
const ForbiddenErrorSchema = z.union([
    errorSchema(z.enum(["forbidden", "session_access_authentication_required"])),
    AccountRouteAuthenticationForbiddenResponseSchema,
]);
const NotFoundErrorSchema = errorSchema(z.literal("session_not_found"));
const PageConflictErrorSchema = errorSchema(z.literal("session_data_key_unavailable"));
const PatchConflictErrorSchema = errorSchema(z.enum([
    "data_key_not_required",
    "recipient_changed",
    "recipient_key_unavailable",
    "session_data_key_unavailable",
]));
const ParamsSchema = z.strictObject({ sessionId: z.string().check(z.minLength(1)) });

/** One code decides one status; there are no per-item errors or retry hints. */
function statusForPageError(error: SessionDataKeyEnvelopePageError): 400 | 403 | 404 | 409 | 503 {
    switch (error) {
        case "invalid_cursor":
            return 400;
        case "forbidden":
        case "session_access_authentication_required":
            return 403;
        case "session_access_authentication_unavailable":
            return 503;
        case "session_data_key_unavailable":
            return 409;
        case "session_not_found":
            return 404;
    }
}

function statusForPatchError(error: SessionDataKeyEnvelopePatchError): 400 | 403 | 404 | 409 | 503 {
    return error === "invalid_request"
        ? 400
        : error === "forbidden" || error === "session_access_authentication_required"
            ? 403
            : error === "session_access_authentication_unavailable"
                ? 503
            : error === "session_not_found"
                ? 404
                : 409;
}

export function registerSessionDataKeyEnvelopeRoutes(app: Fastify) {
    app.get("/v2/sessions/:sessionId/data-key/envelopes", {
        preHandler: app.authenticate,
        config: { restrictedCredentialBinding: { scope: "session", session: "params.sessionId", allowSessionRuntime: false } },
        attachValidation: true,
        schema: {
            params: ParamsSchema,
            querystring: SessionDataKeyEnvelopePageQueryV1Schema,
            response: {
                200: SessionDataKeyEnvelopePageV1Schema,
                400: PageBadRequestErrorSchema,
                403: ForbiddenErrorSchema,
                404: NotFoundErrorSchema,
                409: PageConflictErrorSchema,
                503: errorSchema(z.literal("session_access_authentication_unavailable")),
            },
        },
    }, async (request, reply) => {
        if (request.validationError) {
            return reply.code(400).send({
                error: typeof request.query.cursor === "string"
                    && decodeSessionDataKeyEnvelopeCursorV1(request.query.cursor) === null
                    ? "invalid_cursor"
                    : "invalid_request",
            });
        }
        const result = await readSessionDataKeyEnvelopePage({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            query: request.query,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForPageError(result.error)).send({ error: result.error });
        return reply.send(result.page);
    });

    app.patch("/v2/sessions/:sessionId/data-key/envelopes", {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            params: ParamsSchema,
            body: PatchSessionDataKeyEnvelopesV1Schema,
            response: {
                200: PatchSessionDataKeyEnvelopesResultV1Schema,
                400: InvalidRequestErrorSchema,
                403: ForbiddenErrorSchema,
                404: NotFoundErrorSchema,
                409: PatchConflictErrorSchema,
                503: errorSchema(z.literal("session_access_authentication_unavailable")),
            },
        },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: "invalid_request" });
        const result = await applySessionDataKeyEnvelopes({
            actorAccountId: request.userId,
            sessionId: request.params.sessionId,
            entries: request.body.entries,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });
        if (!result.ok) return reply.code(statusForPatchError(result.error)).send({ error: result.error });
        return reply.send({ appliedCount: result.appliedCount });
    });
}
