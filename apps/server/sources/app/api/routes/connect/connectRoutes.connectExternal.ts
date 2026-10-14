import { z } from "zod/mini";

import { type Fastify } from "../../types";
import { Context } from "@/context";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { disconnectExternalIdentity } from "@/app/auth/providers/identity";
import { IdentityManagementDeniedError } from "@/app/auth/providers/accountIdentityLifecycle";
import { deleteOAuthPendingBestEffort, loadValidOAuthPending } from "./connectRoutes.oauthPending";
import { createExternalAuthorizeAttempt, createExternalAuthorizeUrl } from "./oauthExternal/createExternalAuthorizeUrl";
import { resolveTeamAdmissionStartBinding } from "./oauthExternal/teamAdmissionStartBinding";
import { isTeamMembershipAdmissionEnabled } from "@/app/teams/memberships/membershipService";
import { oauthExternalRateLimitConnectParamsPerUser } from "./oauthExternal/oauthExternalRateLimits";
import { connectPendingSchema } from "./oauthExternal/oauthExternalSchemas";
import { OAUTH_STATE_UNAVAILABLE_CODE } from "@/app/auth/oauthStateErrors";
import { OAUTH_NOT_CONFIGURED_ERROR } from "./oauthExternal/oauthExternalErrors";
import { registerExternalConnectFinalizeRoute } from "./oauthExternal/registerExternalConnectFinalizeRoute";
import { ExternalOAuthErrorResponseSchema, ExternalOAuthParamsResponseSchema } from '@happier-dev/protocol/auth/externalOAuth';
import { NotFoundSchema } from "../../schemas/notFoundSchema";
import { resolveWebAppOAuthReturnUrlFromRequestHeaders } from "./oauthExternal/oauthExternalConfig";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { PresentUserRequiredResponseSchema, requirePresentUser } from "../../utils/requirePresentUser";

export function connectConnectExternalRoutes(app: Fastify) {
    //
    // External provider connection (authenticated identity linking)
    //

    app.get("/v1/connect/external/:provider/params", {
        preHandler: [app.authenticate, requirePresentUser],
        config: { rateLimit: oauthExternalRateLimitConnectParamsPerUser() },
        schema: {
            params: z.object({ provider: z.string() }),
            querystring: z.object({
                connectFinalization: z.optional(z.literal("credential_adoption_v1")),
                purpose: z.optional(z.literal("team_admission")),
                teamId: z.optional(z.string()),
                connectionId: z.optional(z.string()),
                origin: z.optional(z.enum(["home", "team"])),
            }),
            response: {
                200: ExternalOAuthParamsResponseSchema,
                400: ExternalOAuthErrorResponseSchema,
                403: ExternalOAuthErrorResponseSchema,
                404: z.union([NotFoundSchema, z.object({ error: z.literal("unsupported-provider") })]),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const providerId = request.params.provider.toString().trim().toLowerCase();
        // The authenticated Team entry. The member already holds this Account, so the
        // Team identity is linked to it through the connect finalizer rather than
        // seeding a second, freshly provisioned Account.
        const teamAdmission = request.query.purpose === "team_admission";
        const teamId = teamAdmission ? String(request.query.teamId ?? "").trim() : "";
        const teamProviderOrigin = teamAdmission ? request.query.origin ?? "team" : null;
        if (teamAdmission && !teamId) {
            return reply.code(400).send({ error: "invalid-team-admission" });
        }
        if (teamAdmission && !await isTeamMembershipAdmissionEnabled({ env: requestHomeEnv })) {
            return reply.code(403).send({ error: "invalid-team-admission" });
        }
        const resolved = await resolveOAuthRuntimeById(
            requestHomeEnv,
            providerId,
            teamAdmission && teamProviderOrigin === "team" ? { kind: "team", teamId } : undefined,
        );
        if (!resolved) return reply.code(404).send({ error: "unsupported-provider" });
        const { provider, reference } = resolved;

        try {
            const webAppOAuthReturnUrl = resolveWebAppOAuthReturnUrlFromRequestHeaders({
                env: requestHomeEnv,
                providerId,
                headers: request.headers as any,
            });
            if (teamAdmission) {
                const binding = await resolveTeamAdmissionStartBinding({
                    teamId,
                    providerId,
                    origin: teamProviderOrigin!,
                    connectionId: String(request.query.connectionId ?? "").trim(),
                    invitationToken: typeof request.headers["x-happier-team-invitation"] === "string"
                        ? request.headers["x-happier-team-invitation"].trim()
                        : "",
                });
                if (!binding) return reply.code(403).send({ error: "invalid-team-admission" });
                const attempt = await createExternalAuthorizeAttempt({
                    flow: "connect",
                    env: requestHomeEnv,
                    providerId,
                    provider,
                    reference,
                    userId: request.userId,
                    purpose: "team_admission",
                    ...(binding.connection ? { connection: binding.connection } : {}),
                    admission: binding.admission,
                    // Team admission is decided by the authenticated finalizer, so the
                    // callback must hand back a pending rather than complete the link
                    // itself: this start never offers the predecessor direct-connect path.
                    connectFinalization: "credential_adoption_v1",
                    ...(webAppOAuthReturnUrl ? { webAppOAuthReturnUrl } : {}),
                });
                if (!attempt) return reply.code(400).send({ error: OAUTH_STATE_UNAVAILABLE_CODE });
                return reply.send({
                    url: attempt.url,
                    purpose: "team_admission" as const,
                    teamId,
                    admissionReference: attempt.attemptId,
                });
            }
            const url = await createExternalAuthorizeUrl({
                flow: "connect",
                env: requestHomeEnv,
                providerId,
                provider,
                reference,
                userId: request.userId,
                connectFinalization: "credential_adoption_v1",
                ...(webAppOAuthReturnUrl ? { webAppOAuthReturnUrl } : {}),
            });
            if (!url) return reply.code(400).send({ error: OAUTH_STATE_UNAVAILABLE_CODE });
            return reply.send({ url });
        } catch (error) {
            if (error instanceof Error && error.message === OAUTH_NOT_CONFIGURED_ERROR) {
                return reply.code(400).send({ error: OAUTH_NOT_CONFIGURED_ERROR });
            }
            throw error;
        }
    });

    registerExternalConnectFinalizeRoute(app);

    app.delete("/v1/connect/external/:provider/pending/:pending", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ provider: z.string(), pending: z.string() }),
            response: {
                200: z.object({ success: z.literal(true) }),
                404: z.union([NotFoundSchema, z.object({ error: z.literal("unsupported-provider") })]),
            },
        },
    }, async (request, reply) => {
        const requestHomeEnv = await readRequestHomeEnv(request);
        const providerId = request.params.provider.toString().trim().toLowerCase();
        if (!await resolveOAuthRuntimeById(requestHomeEnv, providerId)) {
            return reply.code(404).send({ error: "unsupported-provider" });
        }

        const pendingKey = request.params.pending.toString().trim();
        if (!pendingKey) return reply.send({ success: true });

        const pending = await loadValidOAuthPending(pendingKey);
        if (!pending) return reply.send({ success: true });
        try {
            const parsed = connectPendingSchema.safeParse(JSON.parse(pending.value));
            if (!parsed.success) return reply.send({ success: true });
            if (parsed.data.userId !== request.userId) return reply.send({ success: true });
        } catch {
            return reply.send({ success: true });
        }
        await deleteOAuthPendingBestEffort(pendingKey);
        return reply.send({ success: true });
    });

    app.delete("/v1/connect/external/:provider", {
        preHandler: [app.authenticate, requirePresentUser],
        schema: {
            params: z.object({ provider: z.string() }),
            response: {
                200: z.object({ success: z.literal(true) }),
                403: PresentUserRequiredResponseSchema,
                404: z.union([NotFoundSchema, z.object({ error: z.literal("unsupported-provider") })]),
                409: z.object({
                    error: z.literal("identity-management-denied"),
                    reason: z.enum(["required_by_team", "last_login_method", "management_unavailable"]),
                }),
            },
        },
    }, async (request, reply) => {
        const providerId = request.params.provider.toString().trim().toLowerCase();
        const ctx = Context.create(request.userId);
        try {
            await disconnectExternalIdentity({ providerId, ctx });
        } catch (error) {
            if (error instanceof IdentityManagementDeniedError) {
                return reply.code(409).send({ error: "identity-management-denied", reason: error.reason });
            }
            if (error instanceof Error && error.message === "unsupported-provider") {
                return reply.code(404).send({ error: "unsupported-provider" });
            }
            throw error;
        }
        return reply.send({ success: true });
    });
}
