import { buildAccountStoredContentUpgradeRequired, type AccountStoredContentCompatibilityEvaluation } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { z } from "zod/mini";

import { AnyClientUpgradeRequiredV1Schema } from '@happier-dev/protocol/clientCompatibility/upgradeRequiredV1';
import { OperationUpdateRequiredV1Schema } from '@happier-dev/protocol/compat/operationUpdateRequiredV1';
import { SESSION_METADATA_LAYOUT_VERSION_V1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT, SESSION_LIST_PAGE_MAX_LIMIT } from '@happier-dev/protocol/sessions/listing/query';
import { V2SessionByIdNotFoundSchema, V2SessionByIdResponseSchema, V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { resolveApiHotEndpointRateLimit } from "@/app/api/utils/apiRateLimitCatalog";
import { inTx, type Tx } from "@/storage/inTx";
import { readSnapshotWithCurrentAdmission } from "@/storage/readSnapshotWithCurrentAdmission";
import { type Fastify } from "../../types";
import {
    createV2SessionListRowSelect,
    createV2SessionListLegacyRowSelect,
    mapV2SessionListRow,
    type V2SessionListRowCompat,
} from "@/app/session/listing/rows";
import { readSessionListOtherNamedCollaboratorFacts, readSessionListViewerDiscussionFacts } from "@/app/session/listing/page";
import {
    runWithSessionListProjectionFallback,
    V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
} from "@/app/session/listing/page";
import { listLegacyV1SessionsForAccount } from "@/app/session/listing/legacy";
import { listSessionsForAccount, SessionListInvalidCursorError } from "@/app/session/listing/service";
import { createV2SessionListServerTiming } from "@/app/session/listing/timing";
import { registerSessionFilteredListingRoute } from "./registerSessionFilteredListingRoute";
import {
    createSessionMetadataListRepresentabilityWhere,
    createSessionMetadataPrivacyUpgradeRequiredResponse,
    isSessionMetadataPrivacyUpgradeRequiredError,
    readSessionMetadataOwnerAccountMode,
    requiresSessionMetadataOwnerAccountMode,
    listSessionMetadataPrivacyUpgradeIdsInTx,
} from "@/app/session/metadata/sessionMetadataRecipientProjection";
import {
    enforceCurrentAccountStoredContentCompatibilityForHttpRequest,
    readAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import { resolveSessionAccessForOperation, projectSessionEffectiveAccessV1 } from "@/app/session/access/sessionAccess";
import { readmitSessionRowsWithAdmissionInTx } from "@/app/session/access/sessionReadAdmission";
import { readSessionAccessAuthenticationFromRequest, type SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { listQueuedExecutionRunPendingTargetsForSessions } from "@/app/session/pending/pendingMessageService";
import { loadPendingActivationPublicationInTx } from '@/app/session/pending/publishPendingMutation';
import { PRESENT_USER_REQUIRED_ERROR } from "@/app/api/utils/apiTokenRouteAdmission";
import { projectSessionManagerForRowsInTx, readmitCapturedSessionManagerReferencesInTx, type SessionManagerContribution } from "@/app/session/awareness/sessionManagerProjection";
import { projectSessionTurnWaitingHttpResponse } from '@/app/clientCompatibility/sessionTurnWaitingCompatibility';
import { readAcceptedSessionTeamCredentialProviderModelBindingInTx } from '@/app/teams/credentials/sessionBinding';

const SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA = z.strictObject({
    error: z.literal("Session metadata privacy upgrade required"),
    code: z.literal("metadata_privacy_upgrade_required"),
});

const V2_ACTIVE_SESSION_LIST_QUERYSTRING_SCHEMA = z.optional(z.object({
    limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(V2_ACTIVE_SESSION_LIST_ROW_LIMIT)), V2_ACTIVE_SESSION_LIST_ROW_LIMIT),
}));

const OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA = z.optional((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return value;
}), z.boolean()));

const V2_PAGED_SESSION_LIST_QUERYSTRING_SCHEMA = z.optional(z.object({
    cursor: z.optional(z.string()),
    limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(SESSION_LIST_PAGE_MAX_LIMIT)), SESSION_LIST_PAGE_DEFAULT_LIMIT),
}));

const V2_SESSION_LIST_QUERYSTRING_SCHEMA = z.optional(z.object({
    cursor: z.optional(z.string()),
    attentionCursor: z.optional(z.string()),
    limit: z._default(z.coerce.number().check(z.int(), z.minimum(1), z.maximum(SESSION_LIST_PAGE_MAX_LIMIT)), SESSION_LIST_PAGE_DEFAULT_LIMIT),
    includeAttention: OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA,
    includeActive: OPTIONAL_BOOLEAN_QUERY_PARAM_SCHEMA,
}).check(z.refine((value) => !(value.cursor && value.attentionCursor), { message: "cursor and attentionCursor cannot be combined" })));

async function findV2SessionByIdRowInTx(tx: Tx, params: Readonly<{
    userId: string;
    sessionId: string;
    authentication: SessionAccessAuthentication;
    accessProjectionVersion?: number;
}>) {
    if (params.accessProjectionVersion !== 1) {
        const row = await runWithSessionListProjectionFallback<V2SessionListRowCompat | null>(
            () => tx.session.findUnique({
                where: { id: params.sessionId },
                select: createV2SessionListRowSelect(params),
            }),
            () => tx.session.findUnique({
                where: { id: params.sessionId },
                select: createV2SessionListLegacyRowSelect(params),
            }),
        );
        if (!row) return { admission: { status: "unavailable" as const }, row: null };
        // The released seam is a second presentation of one access decision, not a
        // second admission. Routing it through the canonical owner with the row
        // this route already loaded keeps runtime-credential capping and
        // runtime-principal currentness identical on both projections.
        const admission = await resolveSessionAccessForOperation(tx, {
            accountId: params.userId,
            sessionId: params.sessionId,
            authentication: params.authentication,
            accessMode: "legacy_owner_or_direct",
            row,
        });
        return admission.status === "allowed"
            ? { admission, row }
            : { admission, row: null };
    }
    const admission = await resolveSessionAccessForOperation(tx, {
        accountId: params.userId,
        sessionId: params.sessionId,
        authentication: params.authentication,
    });
    if (admission.status !== "allowed") return { admission, row: null };
    // Version-qualified current detail promises the complete current access,
    // viewer and publication projection. The migration-skew fallback belongs
    // only to released bare detail/list adapters.
    const row = await tx.session.findUnique({
        where: { id: params.sessionId },
        select: createV2SessionListRowSelect(params),
    });
    return { admission, row };
}


/** Shared single/batch read; admission, publication and storage policy stay at this owner. */
export async function readSessionDetail(input: Readonly<{ userId: string; sessionId: string; authentication: SessionAccessAuthentication; accessProjectionVersion?: number; storedContentCompatibility: AccountStoredContentCompatibilityEvaluation }>): Promise<
    | { status: 200; body: z.infer<typeof V2SessionByIdResponseSchema> }
    | { status: 403; body: { error: 'team_authentication_required' } }
    | { status: 404; body: { error: 'Session not found' } }
    | { status: 409; body: ReturnType<typeof createSessionMetadataPrivacyUpgradeRequiredResponse> }
    | { status: 426; body: z.infer<typeof OperationUpdateRequiredV1Schema> | z.infer<typeof AnyClientUpgradeRequiredV1Schema> }
    | { status: 503; body: { error: 'team_authentication_unavailable' } }
> {
    const { userId, sessionId, authentication } = input;

    if (
        input.accessProjectionVersion !== undefined
        && input.accessProjectionVersion !== 1
    ) {
        return { status: 426, body: {
            kind: "update_required",
            operation: "session.detail",
            component: "client",
            reason: "access_projection_version_unsupported",
        } };
    }

    const supportsCurrentStoredContent = input.storedContentCompatibility.supportsCurrentProtocol;
    let contributions: readonly SessionManagerContribution[] = [];
    const result = await readSnapshotWithCurrentAdmission(async (tx) => {
        const { admission, row: session } = await findV2SessionByIdRowInTx(tx, {
            userId,
            sessionId,
            authentication,
            accessProjectionVersion: input.accessProjectionVersion,
        });
        if (admission.status !== "allowed") return { kind: admission.status } as const;
        if (!session) return { kind: "unavailable" } as const;
        if (
            session.metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
            && !supportsCurrentStoredContent
        ) {
            return { kind: "client_update_required" } as const;
        }
        try {
            // The access owner has already verified this exact runtime
            // principal. Do not load or project its hosting Account's
            // private Follow/read/attention/authorship state.
            const verifiedSessionRuntimePrincipal = authentication.sessionRuntimePrincipal !== undefined;
            const ownerAccountMode = requiresSessionMetadataOwnerAccountMode({ session })
                ? await readSessionMetadataOwnerAccountMode(tx, session.accountId)
                : undefined;
            const mappedSessionBase = mapV2SessionListRow({
                row: session,
                userId,
                ownerAccountMode,
                ...(verifiedSessionRuntimePrincipal
                    ? {}
                    : { discussionFacts: await readSessionListViewerDiscussionFacts([session], userId, tx) }),
                hasOtherNamedCollaborator: (await readSessionListOtherNamedCollaboratorFacts([session], userId, tx)).get(session.id),
                effectiveAccess: admission.access,
                verifiedSessionRuntimePrincipal,
            });
            const [mappedSession] = await projectSessionManagerForRowsInTx(tx, {
                accountId: userId,
                authentication,
                sessions: [mappedSessionBase],
                accessMode: input.accessProjectionVersion === 1
                    ? "effective_access_v1" : "legacy_owner_or_direct",
                nowMs: Date.now(),
                captureContributions: rows => { contributions = rows; },
            });
            if (admission.access.level !== "owner") {
                return {
                    kind: "found",
                    payload: V2SessionByIdResponseSchema.parse({ session: mappedSession }),
                } as const;
            }
            const targets = await listQueuedExecutionRunPendingTargetsForSessions({
                accountId: userId,
                sessionIds: [session.id],
                reader: tx,
            });
            return {
                kind: "found",
                payload: V2SessionByIdResponseSchema.parse({
                    session: {
                        ...mappedSession,
                        acceptedTeamCredentialBinding: await readAcceptedSessionTeamCredentialProviderModelBindingInTx(tx, session.id),
                        pendingActivationAuthorization: await loadPendingActivationPublicationInTx(tx, session.id) ?? undefined,
                        pendingExecutionRunIds: targets.map((target) => target.runId),
                    },
                }),
            } as const;
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return { kind: "metadata_privacy_upgrade_required" } as const;
            }
            throw error;
        }
    }, async (tx, captured) => {
        if (captured.kind !== "found") return captured;
        try {
            const admissions = await readmitSessionRowsWithAdmissionInTx(tx, { accountId: userId, authentication,
                accessMode: input.accessProjectionVersion === 1 ? "effective_access_v1" : "legacy_owner_or_direct" }, [captured.payload.session]);
            const admission = admissions.get(sessionId);
            if (!admission) return { kind: "unavailable" } as const;
            if (admission.status !== "allowed") return { kind: admission.status } as const;
            const [session] = await readmitCapturedSessionManagerReferencesInTx(tx, { accountId: userId, authentication,
                accessMode: input.accessProjectionVersion === 1 ? "effective_access_v1" : "legacy_owner_or_direct", sessions: [admission.row], contributions });
            return { ...captured, payload: { session } };
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) return { kind: "metadata_privacy_upgrade_required" } as const;
            throw error;
        }
    });
    if (result.kind === "authentication_required") {
        return { status: 403, body: { error: "team_authentication_required" } };
    }
    if (result.kind === "authentication_unavailable") {
        return { status: 503, body: { error: "team_authentication_unavailable" } };
    }
    if (result.kind === "unavailable") {
        return { status: 404, body: { error: "Session not found" } };
    }
    if (result.kind === "client_update_required") {
        return { status: 426, body: input.storedContentCompatibility.upgradeRequired ?? buildAccountStoredContentUpgradeRequired() };
    }
    if (result.kind === "metadata_privacy_upgrade_required") {
        return { status: 409, body: createSessionMetadataPrivacyUpgradeRequiredResponse() };
    }
    if (result.kind === "found") {
        return { status: 200, body: result.payload };
    }
    throw new Error(`Unexpected Session detail result: ${result.kind}`);
}
export function registerSessionListingRoutes(app: Fastify) {
    registerSessionFilteredListingRoute(app);

    app.get('/v2/sessions/metadata-upgrades', {
        preHandler: app.authenticate,
        config: { rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list") },
        schema: { response: { 200: z.strictObject({ sessionIds: z.array(z.string()) }) } },
    }, async (request, reply) => {
        const sessionIds = await inTx(tx => listSessionMetadataPrivacyUpgradeIdsInTx(tx, request.userId), { isolationLevel: "Serializable" /* Metadata privacy upgrade census must observe storage tuple and access from one snapshot. */, readOnly: true });
        return reply.header("Cache-Control", "no-store").send({ sessionIds });
    });

    app.get('/v1/sessions', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
    }, async (request, reply) => {
        try {
            const payload = await listLegacyV1SessionsForAccount({
                userId: request.userId,
                rowRepresentabilityWhere: createSessionMetadataListRepresentabilityWhere(
                    readAccountStoredContentCompatibilityForHttpRequest(request),
                ),
            });
            if (payload) return reply.send(payload);
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
    });

    app.get('/v2/sessions/active', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
            },
            querystring: V2_ACTIVE_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
    }, async (request, reply) => {
        const timing = createV2SessionListServerTiming(request);
        try {
            const payload = await listSessionsForAccount({
                userId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                source: {
                    kind: "legacy",
                    storage: "active",
                    activeOnly: true,
                    limit: request.query?.limit ?? V2_ACTIVE_SESSION_LIST_ROW_LIMIT,
                },
                timing,
                rowRepresentabilityWhere: createSessionMetadataListRepresentabilityWhere(
                    readAccountStoredContentCompatibilityForHttpRequest(request),
                ),
            });
            if (!payload) return;
            timing.apply(reply);
            return reply.send(payload);
        } catch (error) {
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
    });

    app.get('/v2/sessions', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: app.authenticate,
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                400: z.object({ error: z.literal('Invalid cursor format') }),
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
            },
            querystring: V2_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
    }, async (request, reply) => {
        const timing = createV2SessionListServerTiming(request);
        try {
            const payload = await listSessionsForAccount({
                userId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                source: { kind: "legacy", storage: "active", ...request.query },
                timing,
                rowRepresentabilityWhere: createSessionMetadataListRepresentabilityWhere(
                    readAccountStoredContentCompatibilityForHttpRequest(request),
                ),
            });
            if (!payload) return;
            timing.apply(reply);
            return reply.send(payload);
        } catch (error) {
            if (error instanceof SessionListInvalidCursorError) {
                return reply.code(400).send({ error: "Invalid cursor format" });
            }
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
    });

    app.get('/v2/sessions/archived', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: app.authenticate,
        config: {
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "sessions.list"),
        },
        schema: {
            response: {
                200: V2SessionListResponseSchema,
                400: z.object({ error: z.literal('Invalid cursor format') }),
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
            },
            querystring: V2_PAGED_SESSION_LIST_QUERYSTRING_SCHEMA,
        },
    }, async (request, reply) => {
        const timing = createV2SessionListServerTiming(request);
        try {
            const payload = await listSessionsForAccount({
                userId: request.userId,
                authentication: readSessionAccessAuthenticationFromRequest(request),
                source: { kind: "legacy", storage: "archived", ...request.query },
                timing,
                rowRepresentabilityWhere: createSessionMetadataListRepresentabilityWhere(
                    readAccountStoredContentCompatibilityForHttpRequest(request),
                ),
            });
            if (!payload) return;
            timing.apply(reply);
            return reply.send(payload);
        } catch (error) {
            if (error instanceof SessionListInvalidCursorError) {
                return reply.code(400).send({ error: "Invalid cursor format" });
            }
            if (isSessionMetadataPrivacyUpgradeRequiredError(error)) {
                return reply.code(409).send(createSessionMetadataPrivacyUpgradeRequiredResponse());
            }
            throw error;
        }
    });

    app.get('/v2/sessions/:sessionId', {
        preSerialization: projectSessionTurnWaitingHttpResponse,
        preHandler: app.authenticate,
        config: {
            restrictedCredentialBinding: { scope: "session", session: "params.sessionId" },
            rateLimit: resolveApiHotEndpointRateLimit(process.env, "session.detail"),
            apiTokenSessionAction: "session.transcript.get",
        },
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            querystring: z.optional(z.object({
                accessProjectionVersion: z.optional(z.coerce.number().check(z.int(), z.positive())),
            })),
            response: {
                200: V2SessionByIdResponseSchema,
                403: z.union([
                    z.strictObject({ error: z.literal("team_authentication_required") }),
                    z.strictObject({ error: z.literal(PRESENT_USER_REQUIRED_ERROR) }),
                    z.strictObject({ error: z.literal("credential_scope_denied") }),
                ]),
                404: V2SessionByIdNotFoundSchema,
                409: SESSION_METADATA_PRIVACY_UPGRADE_REQUIRED_RESPONSE_SCHEMA,
                426: z.union([
                    OperationUpdateRequiredV1Schema,
                    AnyClientUpgradeRequiredV1Schema,
                ]),
                503: z.strictObject({ error: z.literal("team_authentication_unavailable") }),
            },
        },
    }, async (request, reply) => {
        const result = await readSessionDetail({ userId: request.userId, sessionId: request.params.sessionId, authentication: readSessionAccessAuthenticationFromRequest(request), accessProjectionVersion: request.query?.accessProjectionVersion, storedContentCompatibility: readAccountStoredContentCompatibilityForHttpRequest(request) });
        return reply.code(result.status).send(result.body);
    });
}
