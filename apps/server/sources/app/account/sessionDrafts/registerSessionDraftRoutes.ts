import { SESSION_DRAFT_ROUTE_LIST, SESSION_DRAFT_ROUTE_MUTATE, SESSION_DRAFT_ROUTE_READ, SessionDraftListRequestV1Schema, SessionDraftListResponseV1Schema, SessionDraftMutateRequestV1Schema, SessionDraftMutateResponseV1Schema, SessionDraftReadRequestV1Schema, SessionDraftReadResponseV1Schema, SessionDraftRouteErrorResponseV1Schema } from '@happier-dev/protocol/drafts/sessionDrafts';
import { SESSION_DRAFT_V2_ROUTE_LIST, SESSION_DRAFT_V2_ROUTE_MUTATE, SESSION_DRAFT_V2_ROUTE_READ, SessionDraftListRequestV2Schema, SessionDraftListResponseV2Schema, SessionDraftMutateRequestV2Schema, SessionDraftMutateResponseV2Schema, SessionDraftReadRequestV2Schema, SessionDraftReadResponseV2Schema, SessionDraftEpochUnavailableResponseV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import { type Fastify } from "@/app/api/types";

import { listSessionDrafts, mutateSessionDraft, readSessionDraft } from "./sessionDraftService";
import { readSessionAccessAuthenticationFromRequest } from "@/app/session/access/sessionAccessAuthentication";

type MutationResult = Awaited<ReturnType<typeof mutateSessionDraft>>;

type MutationFailureResult = Extract<
    MutationResult,
    { status: "invalidContentMode" | "invalidAddressBinding" | "sessionUnavailable" }
>;

type MutationFailure = Readonly<{
    code: 400 | 404;
    error: "invalid_content_mode" | "invalid_address_binding" | "session_unavailable";
}>;

/**
 * Narrows the shared service result so a refused mutation can never be sent as
 * a draft response body on either epoch.
 */
function isMutationFailure(result: MutationResult): result is MutationFailureResult {
    return result.status === "invalidContentMode"
        || result.status === "invalidAddressBinding"
        || result.status === "sessionUnavailable";
}

function mutationFailure(result: MutationFailureResult): MutationFailure {
    if (result.status === "invalidContentMode") return { code: 400, error: "invalid_content_mode" };
    if (result.status === "invalidAddressBinding") return { code: 400, error: "invalid_address_binding" };
    return { code: 404, error: "session_unavailable" };
}

/**
 * Both route epochs delegate to the same transactional service, KV prefix,
 * cipher, revision CAS and deletion owners. The V1 handlers re-validate their
 * result against the released V1 schemas so a V2-only row can never leave
 * through a V1 response.
 */
export function registerSessionDraftRoutes(app: Fastify): void {
    app.post(SESSION_DRAFT_ROUTE_READ, {
        preHandler: app.authenticate,
        schema: {
            body: SessionDraftReadRequestV1Schema,
            response: { 200: SessionDraftReadResponseV1Schema, 409: SessionDraftEpochUnavailableResponseV2Schema },
        },
    }, async (request, reply) => {
        const result = await readSessionDraft({ accountId: request.userId, address: request.body.address, epoch: "v1", authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (result.status === "epochUnavailable") return reply.code(409).send({ error: "session_draft_epoch_unavailable" });
        return reply.send(SessionDraftReadResponseV1Schema.parse(result));
    });

    app.post(SESSION_DRAFT_ROUTE_LIST, {
        preHandler: app.authenticate,
        schema: {
            body: SessionDraftListRequestV1Schema,
            response: { 200: SessionDraftListResponseV1Schema },
        },
    }, async (request, reply) => reply.send(SessionDraftListResponseV1Schema.parse(await listSessionDrafts({
        accountId: request.userId,
        ...request.body,
        epoch: "v1",
        authentication: readSessionAccessAuthenticationFromRequest(request),
    }))));

    app.post(SESSION_DRAFT_ROUTE_MUTATE, {
        preHandler: app.authenticate,
        schema: {
            body: SessionDraftMutateRequestV1Schema,
            response: {
                200: SessionDraftMutateResponseV1Schema,
                400: SessionDraftRouteErrorResponseV1Schema,
                404: SessionDraftRouteErrorResponseV1Schema,
                409: SessionDraftEpochUnavailableResponseV2Schema,
            },
        },
    }, async (request, reply) => {
        const result = await mutateSessionDraft({ accountId: request.userId, ...request.body, epoch: "v1", authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (result.status === "epochUnavailable") return reply.code(409).send({ error: "session_draft_epoch_unavailable" });
        if (isMutationFailure(result)) {
            const failure = mutationFailure(result);
            return reply.code(failure.code).send({ error: failure.error });
        }
        return reply.send(SessionDraftMutateResponseV1Schema.parse(result));
    });

    app.post(SESSION_DRAFT_V2_ROUTE_READ, {
        preHandler: app.authenticate,
        schema: {
            body: SessionDraftReadRequestV2Schema,
            response: { 200: SessionDraftReadResponseV2Schema, 409: SessionDraftEpochUnavailableResponseV2Schema },
        },
    }, async (request, reply) => {
        const result = await readSessionDraft({ accountId: request.userId, address: request.body.address, epoch: "v2", authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (result.status === "epochUnavailable") return reply.code(409).send({ error: "session_draft_epoch_unavailable" });
        return reply.send(result);
    });

    app.post(SESSION_DRAFT_V2_ROUTE_LIST, {
        preHandler: app.authenticate,
        schema: {
            body: SessionDraftListRequestV2Schema,
            response: { 200: SessionDraftListResponseV2Schema },
        },
    }, async (request, reply) => reply.send(await listSessionDrafts({
        accountId: request.userId,
        ...request.body,
        epoch: "v2",
        authentication: readSessionAccessAuthenticationFromRequest(request),
    })));

    app.post(SESSION_DRAFT_V2_ROUTE_MUTATE, {
        preHandler: app.authenticate,
        schema: {
            body: SessionDraftMutateRequestV2Schema,
            response: {
                200: SessionDraftMutateResponseV2Schema,
                400: SessionDraftRouteErrorResponseV1Schema,
                404: SessionDraftRouteErrorResponseV1Schema,
                409: SessionDraftEpochUnavailableResponseV2Schema,
            },
        },
    }, async (request, reply) => {
        const result = await mutateSessionDraft({ accountId: request.userId, ...request.body, epoch: "v2", authentication: readSessionAccessAuthenticationFromRequest(request) });
        if (result.status === "epochUnavailable") return reply.code(409).send({ error: "session_draft_epoch_unavailable" });
        if (isMutationFailure(result)) {
            const failure = mutationFailure(result);
            return reply.code(failure.code).send({ error: failure.error });
        }
        return reply.send(result);
    });
}
