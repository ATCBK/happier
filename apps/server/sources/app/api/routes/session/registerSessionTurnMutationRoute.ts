import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { buildSessionAccessWhere } from "@/app/session/access/sessionAccessWhere";
import { SessionTurnMutationReceiptV1Schema, SessionTurnMutationV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { SessionTurnsProjectionV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { projectSessionTurnWaitingHttpResponse } from '@/app/clientCompatibility/sessionTurnWaitingCompatibility';
import { z } from "zod/mini";

import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";
import { readCurrentSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import {
    isExternalShareableSessionTurnVisible,
    isSessionTranscriptShareable,
    loadSessionTranscriptPublication,
    resolveSessionTranscriptNonOwnerRecencyMs,
} from "@/app/session/sessionTranscriptPublicationPolicy";
import {
    parseStoredSessionTurns,
    type SessionTurnStoredRow,
} from "@/app/session/turns/parseSessionTurnState";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { publishSessionTurnMutationUpdate } from "@/app/session/turns/publishSessionTurnMutationUpdate";
import { inTx } from "@/storage/inTx";
import { type Fastify } from "../../types";
import { PRESENT_USER_REQUIRED_ERROR } from "@/app/api/utils/apiTokenRouteAdmission";


/** Shared single/batch read; admission, publication and storage policy stay at this owner. */
export async function readSessionTurns(input: Readonly<{ userId: string; sessionId: string; authentication: SessionAccessAuthentication }>): Promise<
    | { status: 200; body: z.infer<typeof SessionTurnsProjectionV1Schema> }
    | { status: 404; body: { error: 'Session not found' } }
> {
    const { userId, sessionId, authentication } = input;
    const { session, rows, publication, currentlyAccessible } = await inTx(async (tx) => {
        const currentParticipantWhere = { AND: [{ id: sessionId }, await buildSessionAccessWhere({ tx, accountId: userId, capability: 'readTranscript', mode: 'effective_access_v1', authentication })] };
        const rows = await tx.sessionTurn.findMany({
            where: {
                sessionId,
                session: currentParticipantWhere,
            },
            orderBy: [{ updatedAt: "asc" }, { createdAt: "asc" }],
        }) as SessionTurnStoredRow[];
        const session = await tx.session.findFirst({
            where: currentParticipantWhere,
            select: {
                latestTurnId: true,
                updatedAt: true,
            },
        });
        const publication = await loadSessionTranscriptPublication(tx, sessionId);
        return {
            session,
            rows,
            publication,
            currentlyAccessible: session !== null,
        };
    }, { isolationLevel: "Serializable" /* Turn, Session and publication visibility must come from one admitted snapshot. */, readOnly: true });
    if (!session || !currentlyAccessible || (await readCurrentSessionAccessForOperation({
        accountId: userId, sessionId, authentication, capability: "readTranscript",
    })).status !== "allowed") {
        return { status: 404, body: { error: "Session not found" } };
    }

    const visibleRows = rows.filter((row) =>
        isExternalShareableSessionTurnVisible({ row, publication }));
    const turns = parseStoredSessionTurns(visibleRows);
    const visibleTurnIds = new Set(turns.map((turn) => turn.turnId));
    const updatedAt = isSessionTranscriptShareable(publication)
        ? resolveSessionTranscriptNonOwnerRecencyMs(publication, session.updatedAt)
        : 0;

    return { status: 200, body: {
        v: 1 as const,
        sessionId,
        ...(session.latestTurnId && visibleTurnIds.has(session.latestTurnId)
            ? { latestTurnId: session.latestTurnId }
            : {}),
        updatedAt,
        turns,
    } };
}
export function registerSessionTurnMutationRoute(app: Fastify) {
    app.post("/v1/sessions/:sessionId/turns/mutations", {
        preHandler: app.authenticate,
        config: { restrictedCredentialBinding: { scope: "session", session: "params.sessionId" } },
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: SessionTurnMutationV1Schema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    applied: z.boolean(),
                    reason: z.optional(z.string()),
                    receipt: SessionTurnMutationReceiptV1Schema,
                }),
                400: z.object({
                    error: z.literal("Invalid parameters"),
                    code: z.optional(z.string()),
                }),
                403: z.union([
                    z.object({ error: z.literal("Forbidden") }),
                    z.object({ error: z.literal(PRESENT_USER_REQUIRED_ERROR) }),
                ]),
                404: z.object({ error: z.literal("Session not found") }),
                500: z.object({ error: z.literal("Failed to update session") }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const parsed = SessionTurnMutationV1Schema.safeParse(request.body);
        if (!parsed.success || parsed.data.sessionId !== sessionId) {
            return reply.code(400).send({ error: "Invalid parameters" });
        }

        const result = await applySessionTurnMutation({
            actorUserId: userId,
            mutation: parsed.data,
            authentication: readSessionAccessAuthenticationFromRequest(request),
        });

        if (!result.ok) {
            if (result.error === "invalid-params") {
                return reply.code(400).send({
                    error: "Invalid parameters",
                    ...(result.code ? { code: result.code } : {}),
                });
            }
            if (result.error === "forbidden") return reply.code(403).send({ error: "Forbidden" });
            if (result.error === "session-not-found") return reply.code(404).send({ error: "Session not found" });
            return reply.code(500).send({ error: "Failed to update session" });
        }

        await publishSessionTurnMutationUpdate({
            sessionId,
            actorUserId: userId,
            result,
        });

        return reply.send({
            success: true as const,
            applied: result.didApply,
            ...(result.reason ? { reason: result.reason } : {}),
            receipt: result.receipt,
        });
    });

    app.get("/v1/sessions/:sessionId/turns", {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
            apiTokenSessionAction: "session.transcript.get",
        },
        schema: {
            params: z.object({ sessionId: z.string() }),
            querystring: z.strictObject({}),
            response: {
                200: SessionTurnsProjectionV1Schema,
                404: z.object({ error: z.literal("Session not found") }),
            },
        },
    }, async (request, reply) => {
        const result = await readSessionTurns({ userId: request.userId, sessionId: request.params.sessionId, authentication: readSessionAccessAuthenticationFromRequest(request) });
        return reply.code(result.status).send(result.body);
    });
}
