import { resolveConfiguredPublicServerUrl } from "@/app/serverUrls/effectiveServerUrls";
import { managedGitHubAppUserAuthorizationCallbackUrl } from "./githubManagedAppManifest";
import { ManagedGitHubAppCreateInputV1Schema, ManagedGitHubAppCreateOutputV1Schema, ManagedGitHubAppManifestSetupStartInputV1Schema, ManagedGitHubAppManifestSetupStartOutputV1Schema, ManagedGitHubAppUpdateInputV1Schema, ManagedGitHubAppUpdateOutputV1Schema, ManagedGitHubAppInstallationV1Schema, ManagedGitHubAppErrorV1Schema, ManagedGitHubAppRemoveInputV1Schema, ManagedGitHubAppRemoveOutputV1Schema, ManagedGitHubAppsListInputV1Schema, ManagedGitHubAppsListOutputV1Schema, ManagedGitHubAppVerifyInstallationInputV1Schema, ManagedGitHubAppVerifyInstallationOutputV1Schema, type ManagedGitHubAppErrorCodeV1 } from '@happier-dev/protocol/identity/githubApps';
import { TeamIdentityErrorV1Schema, type TeamIdentityErrorCodeV1 } from '@happier-dev/protocol/teams';
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
    beginGitHubAppManifestSetup,
    completeGitHubAppManifestInstallationSetup,
    consumeGitHubAppManifestLaunch,
    renderGitHubAppManifestSubmissionPage,
} from "./githubManagedAppManifest";

import type { Fastify } from "@/app/api/types";
import { readTeamOperationAuthenticationFromRequest } from "@/app/teams/actorContext";
import { homeDomainActionPathForMethod } from "@/app/api/routes/actions/homeDomainActionRoute";
import {
    createGitHubAppRegistration,
    listGitHubAppRegistrations,
    removeGitHubAppInstallation,
    beginGitHubAppInstallationVerification,
    updateGitHubAppRegistration,
    type GitHubAppInstallationAdministrationView,
    type GitHubAppRegistrationView,
} from "./githubManagedAppLifecycle";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";

/**
 * GitHub App administration is Team identity administration when the App is
 * Team-owned, so its refusals include the same two authentication outcomes the
 * Home's managed identity provider routes already return. The response is the
 * union of both existing contracts rather than a third error vocabulary.
 */
const ManagedGitHubAppRouteErrorV1Schema = ManagedGitHubAppErrorV1Schema.or(TeamIdentityErrorV1Schema);

const ERROR_RESPONSES = {
    403: ManagedGitHubAppRouteErrorV1Schema,
    404: ManagedGitHubAppRouteErrorV1Schema,
    409: ManagedGitHubAppRouteErrorV1Schema,
    502: ManagedGitHubAppRouteErrorV1Schema,
    503: ManagedGitHubAppRouteErrorV1Schema,
} as const;

/**
 * The safe registration projection plus the callback URL an administrator
 * registers on the App. The callback is derived from the Home's public server
 * URL, never persisted, and omitted when no public URL is configured rather
 * than guessed.
 */
export function projectManagedGitHubAppRegistrationV1(row: GitHubAppRegistrationView, env: NodeJS.ProcessEnv) {
    const publicServerUrl = resolveConfiguredPublicServerUrl(env);
    return {
        ...row,
        githubAppId: row.githubAppId.toString(),
        githubOwnerId: row.githubOwnerId?.toString() ?? null,
        lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        ...(publicServerUrl ? { callbackUrl: managedGitHubAppUserAuthorizationCallbackUrl(publicServerUrl) } : {}),
    };
}

/** The callback is derived from the request's configuration overlay: a stored or inferred address counts (§3.2). */
function projectRegistration(row: GitHubAppRegistrationView, env: NodeJS.ProcessEnv) {
    return projectManagedGitHubAppRegistrationV1(row, env);
}

function projectInstallation(row: GitHubAppInstallationAdministrationView) {
    return ManagedGitHubAppInstallationV1Schema.parse({
        ...row,
        githubInstallationId: row.githubInstallationId.toString(),
        githubOrganizationId: row.githubOrganizationId.toString(),
        suspendedAt: row.suspendedAt?.toISOString() ?? null,
        lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    });
}

type ManagedGitHubAppRouteErrorCode = ManagedGitHubAppErrorCodeV1 | Extract<TeamIdentityErrorCodeV1,
    "team_authentication_required" | "team_authentication_unavailable">;

/**
 * One place decides how an administration refusal reaches the client. The Team
 * authentication outcomes travel unchanged so the client can offer
 * re-authentication; every other refusal keeps the GitHub App code it had.
 */
export function managedGitHubAppRefusalCode(
    status: string,
    otherwise: ManagedGitHubAppRouteErrorCode | "forbidden" = "github_app_forbidden",
): ManagedGitHubAppRouteErrorCode {
    if (status === "team_authentication_required" || status === "team_authentication_unavailable") return status;
    return status === "forbidden" || otherwise === "forbidden" ? "github_app_forbidden" : otherwise;
}

function errorStatus(code: ManagedGitHubAppRouteErrorCode): 403 | 404 | 409 | 502 | 503 {
    if (code === "github_app_forbidden" || code === "github_enterprise_origin_not_approved") return 403;
    if (code === "team_authentication_required") return 403;
    if (code === "team_authentication_unavailable") return 503;
    if (code === "github_app_not_found") return 404;
    if (code === "github_administrator_evidence_unavailable" || code === "github_installation_evidence_invalid") {
        return 502;
    }
    return 409;
}

export function registerManagedGitHubAppRoutes(app: Fastify): void {
    app.get(
        "/v1/identity/github-apps/manifest-setup/submit",
        { schema: { querystring: z.object({ handle: z.string().trim().min(1).max(512) }).strict() } },
        async (request, reply) => {
            const launch = await consumeGitHubAppManifestLaunch(request.query.handle);
            if (!launch) {
                return await reply.code(410).type("text/plain; charset=utf-8").send(
                    "This GitHub App setup link has expired or was already used.",
                );
            }
            const nonce = randomBytes(18).toString("base64url");
            reply.header("cache-control", "no-store");
            reply.header("referrer-policy", "no-referrer");
            reply.header(
                "content-security-policy",
                `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'`,
            );
            return await reply.type("text/html; charset=utf-8").send(
                renderGitHubAppManifestSubmissionPage(launch, nonce),
            );
        },
    );

    app.get(
        "/v1/identity/github-apps/manifest-setup/complete",
        {
            schema: {
                querystring: z.object({
                    state: z.string().min(1),
                    installation_id: z.string().regex(/^[1-9][0-9]*$/u),
                    setup_action: z.string().optional(),
                }).strict(),
            },
        },
        async (request, reply) => {
            const requestHomeEnv = await readRequestHomeEnv(request);
            const result = await completeGitHubAppManifestInstallationSetup({
                state: request.query.state,
                githubInstallationId: BigInt(request.query.installation_id),
                env: requestHomeEnv,
            });
            if (result.status === "ready") return await reply.redirect(result.authorizeUrl);
            const code = result.status === "forbidden" || result.status === "team_authentication_required"
                ? 403
                : result.status === "team_authentication_unavailable" ? 503 : 409;
            return await reply.code(code).send({ error: result.status });
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.githubApps.list", "POST"),
        {
            preHandler: [app.authenticate],
            schema: { body: ManagedGitHubAppsListInputV1Schema, response: { 200: ManagedGitHubAppsListOutputV1Schema, ...ERROR_RESPONSES } },
        },
        async (request, reply) => {
            const requestHomeEnv = await readRequestHomeEnv(request);
            const result = await listGitHubAppRegistrations({
                ...readTeamOperationAuthenticationFromRequest(request),
                actorAccountId: request.userId,
                owner: request.body.owner,
            });
            if (result.status !== "ready") {
                const error = managedGitHubAppRefusalCode(result.status);
                return await reply.code(errorStatus(error)).send({ error });
            }
            return await reply.send({
                registrations: result.registrations.map((row) => projectRegistration(row, requestHomeEnv)),
                installations: result.installations.map(projectInstallation),
            });
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.githubApps.create", "POST"),
        {
            preHandler: [app.authenticate],
            schema: { body: ManagedGitHubAppCreateInputV1Schema, response: { 200: ManagedGitHubAppCreateOutputV1Schema, ...ERROR_RESPONSES } },
        },
        async (request, reply) => {
            const input = request.body;
            const result = await createGitHubAppRegistration({
                ...readTeamOperationAuthenticationFromRequest(request),
                actorAccountId: request.userId,
                owner: input.owner,
                input: {
                    githubHost: input.githubHost,
                    githubAppId: BigInt(input.githubAppId),
                    githubClientId: input.githubClientId,
                    ...(input.githubAppSlug !== undefined ? { githubAppSlug: input.githubAppSlug } : {}),
                    ...(input.githubOwnerId !== undefined ? { githubOwnerId: input.githubOwnerId === null ? null : BigInt(input.githubOwnerId) } : {}),
                    ...(input.githubOwnerLogin !== undefined ? { githubOwnerLogin: input.githubOwnerLogin } : {}),
                    secrets: { v: 1, ...input.secrets },
                },
            });
            if (result.status !== "created") {
                const error = managedGitHubAppRefusalCode(
                    result.status,
                    result.status === "forbidden" ? "github_app_forbidden" : result.status,
                );
                return await reply.code(errorStatus(error)).send({ error });
            }
            return await reply.send({ registration: projectRegistration(result.registration, await readRequestHomeEnv(request)) });
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.githubApps.manifestSetup.start", "POST"),
        {
            preHandler: [app.authenticate],
            schema: {
                body: ManagedGitHubAppManifestSetupStartInputV1Schema,
                response: { 200: ManagedGitHubAppManifestSetupStartOutputV1Schema, ...ERROR_RESPONSES },
            },
        },
        async (request, reply) => {
            const requestHomeEnv = await readRequestHomeEnv(request);
            const result = await beginGitHubAppManifestSetup({
                ...readTeamOperationAuthenticationFromRequest(request),
                actorAccountId: request.userId,
                owner: request.body.owner,
                appName: request.body.appName,
                githubOwner: request.body.githubOwner,
                env: requestHomeEnv,
            });
            if (result.status !== "ready") {
                const error = managedGitHubAppRefusalCode(
                    result.status,
                    result.status === "forbidden" ? "github_app_forbidden" : result.status,
                );
                return await reply.code(errorStatus(error)).send({ error });
            }
            return await reply.send({ authorizeUrl: result.authorizeUrl });
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.githubApps.update", "POST"),
        {
            preHandler: [app.authenticate],
            schema: { body: ManagedGitHubAppUpdateInputV1Schema, response: { 200: ManagedGitHubAppUpdateOutputV1Schema, ...ERROR_RESPONSES } },
        },
        async (request, reply) => {
            const input = request.body;
            const result = await updateGitHubAppRegistration({
                ...readTeamOperationAuthenticationFromRequest(request),
                actorAccountId: request.userId,
                owner: input.owner,
                registrationId: input.registrationId,
                expectedRevision: input.expectedRevision,
                patch: input.patch,
            });
            if (result.status !== "updated") {
                const error = managedGitHubAppRefusalCode(
                    result.status,
                    result.status === "not_found"
                        ? "github_app_not_found"
                        : result.status === "github_enterprise_origin_not_approved"
                            ? result.status
                            : "github_app_revision_conflict",
                );
                return await reply.code(errorStatus(error)).send({ error });
            }
            return await reply.send({ registration: projectRegistration(result.registration, await readRequestHomeEnv(request)) });
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.githubApps.verifyInstallation", "POST"),
        {
            preHandler: [app.authenticate],
            schema: { body: ManagedGitHubAppVerifyInstallationInputV1Schema, response: { 200: ManagedGitHubAppVerifyInstallationOutputV1Schema, ...ERROR_RESPONSES } },
        },
        async (request, reply) => {
            const requestHomeEnv = await readRequestHomeEnv(request);
            const input = request.body;
            const result = await beginGitHubAppInstallationVerification({
                ...readTeamOperationAuthenticationFromRequest(request),
                actorAccountId: request.userId,
                owner: input.owner,
                registrationId: input.registrationId,
                expectedRegistrationRevision: input.expectedRegistrationRevision,
                expectedInstallationRevision: input.expectedInstallationRevision,
                githubInstallationId: BigInt(input.githubInstallationId),
                githubOrganizationId: BigInt(input.githubOrganizationId),
                env: requestHomeEnv,
            });
            if (result.status !== "ready") {
                const error = managedGitHubAppRefusalCode(
                    result.status,
                    result.status === "not_found" ? "github_app_not_found"
                        : result.status === "registration_revision_conflict" ? "github_app_revision_conflict"
                            : result.status,
                );
                return await reply.code(errorStatus(error)).send({ error });
            }
            return await reply.send({
                authorizeUrl: result.authorizeUrl,
                attemptId: result.attemptId,
            });
        },
    );

    app.post(
        homeDomainActionPathForMethod("identity.githubApps.remove", "POST"),
        {
            preHandler: [app.authenticate],
            schema: { body: ManagedGitHubAppRemoveInputV1Schema, response: { 200: ManagedGitHubAppRemoveOutputV1Schema, ...ERROR_RESPONSES } },
        },
        async (request, reply) => {
            const input = request.body;
            const result = await removeGitHubAppInstallation({
                ...readTeamOperationAuthenticationFromRequest(request),
                actorAccountId: request.userId,
                owner: input.owner,
                installationId: input.installationId,
                expectedRevision: input.expectedRevision,
            });
            if (result.status !== "removed") {
                const error = managedGitHubAppRefusalCode(
                    result.status,
                    result.status === "not_found" ? "github_app_not_found"
                        : result.status === "revision_conflict" ? "github_app_revision_conflict"
                            : "github_installation_in_use",
                );
                return await reply.code(errorStatus(error)).send({ error, ...(result.status === "blocked" ? { blockers: result.blockers } : {}) });
            }
            return await reply.send({ removed: true as const });
        },
    );
}
