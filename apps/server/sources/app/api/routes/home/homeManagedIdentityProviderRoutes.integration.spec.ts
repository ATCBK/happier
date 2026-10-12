import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const discoveryCapabilities = vi.hoisted(() => ({
    pkceS256: true,
    error: null as Error | null,
}));
vi.mock("openid-client", async () => {
    const actual = await vi.importActual<typeof import("openid-client")>("openid-client");
    return {
        ...actual,
        discovery: vi.fn(async (issuer: URL) => {
            if (discoveryCapabilities.error) throw discoveryCapabilities.error;
            return {
                serverMetadata: () => ({
                    issuer: issuer.href.replace(/\/$/u, ""),
                    authorization_endpoint: `${issuer.origin}/authorize`,
                    response_types_supported: ["code"],
                    code_challenge_methods_supported: discoveryCapabilities.pkceS256 ? ["S256"] : [],
                }),
            };
        }),
        buildAuthorizationUrl: vi.fn((_config: unknown, params: { state: string }) =>
            new URL(`https://id.example.test/authorize?state=${encodeURIComponent(params.state)}`)),
    };
});

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { enableAuthentication } from "../../utils/enableAuthentication";
import { homeGovernanceRoutes } from "./homeGovernanceRoutes";
import { resolveOAuthRuntimeById } from "@/app/auth/providers/identityProviderCatalog";
import { HOME_PROVIDER_CONTEXT } from "@/app/auth/providers/providerReference";
import { createIdentityConnectionTestResult } from "@/app/api/routes/connect/oauthExternal/identityConnectionTestResult";
import { OutboundIdentityEndpointError } from "@/app/net/outboundIdentityNetworkPolicy";

const { trackApp, closeTrackedApps } = createAppCloseTracker();
let harness: LightSqliteHarness;
let sequence = 0;
const originalPublicServerUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;

const config = {
    v: 1,
    kind: "oidc",
    issuer: "https://id.example.test",
    clientId: "happier",
    clientAuthenticationMethod: "client_secret_post",
    scopes: "openid profile email",
    httpTimeoutSeconds: 30,
    claims: { login: "preferred_username", email: "email", groups: "groups" },
    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
    fetchUserInfo: true,
    storeRefreshToken: false,
    ui: { buttonColor: null, iconHint: "oidc" },
} as const;

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    homeGovernanceRoutes(typed);
    return trackApp(typed);
}

async function createAccount(homeRole: "owner" | "member") {
    sequence += 1;
    const account = await db.account.create({
        data: { publicKey: `managed-provider-route-${sequence}`, encryptionMode: "plain", homeRole },
        select: { id: true },
    });
    const token = await auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" });
    const automationToken = await auth.createToken(account.id, undefined, {
        kind: "terminal",
        authority: "account_automation",
    });
    return { id: account.id, token, automationToken };
}

async function post(app: ReturnType<typeof createTestApp>, path: string, token: string, payload: unknown) {
    return await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${token}` },
        payload,
    });
}

async function readHomeGovernanceInvalidation(accountId: string) {
    const [account, change] = await Promise.all([
        db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } }),
        db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId,
                    kind: "account",
                    entityId: "home-governance",
                },
            },
            select: { cursor: true },
        }),
    ]);
    return { seq: account.seq, cursor: change?.cursor ?? null };
}

beforeAll(async () => {
    process.env.HAPPIER_PUBLIC_SERVER_URL = "https://home.example.test";
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-managed-provider-routes-",
        initAuth: true,
        initEncrypt: true,
        initFiles: true,
    });
}, 120_000);
afterAll(async () => {
    if (originalPublicServerUrl === undefined) delete process.env.HAPPIER_PUBLIC_SERVER_URL;
    else process.env.HAPPIER_PUBLIC_SERVER_URL = originalPublicServerUrl;
    await harness.close();
});
afterEach(async () => {
    discoveryCapabilities.pkceS256 = true;
    discoveryCapabilities.error = null;
    await closeTrackedApps();
    await db.accountIdentity.deleteMany({});
    await db.teamIdentityConnection.deleteMany({});
    await db.identityProviderInstance.deleteMany({});
    await db.gitHubAppInstallation.deleteMany({});
    await db.gitHubAppRegistration.deleteMany({});
    await db.teamMembership.deleteMany({});
    await db.team.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home managed identity-provider routes", () => {
    it("lists a Home installation-backed GitHub identity candidate through the shared lifecycle projection", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const now = new Date();
        const registration = await db.gitHubAppRegistration.create({
            data: {
                githubHost: "https://github.com",
                githubAppId: 101n,
                githubClientId: "Iv1.home-identity",
                config: {
                    v: 1,
                    secretHealth: {
                        clientSecretConfigured: true,
                        privateKeyConfigured: true,
                        webhookSecretConfigured: false,
                    },
                },
                encryptedSecrets: Uint8Array.from([1]),
                state: "verified",
                lastVerifiedAt: now,
                createdByAccountId: owner.id,
            },
        });
        const installation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: registration.id,
                githubInstallationId: 201n,
                githubOrganizationId: 301n,
                githubOrganizationLogin: "Acme",
                repositorySelection: "selected",
                state: "verified",
                verifiedPermissions: { members: "read" },
                verifiedEvents: [],
                lastVerifiedAt: now,
            },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                kind: "github_app_identity",
                displayName: "Acme GitHub",
                config: { v: 1, kind: "github_app_identity" },
                githubAppInstallationId: installation.id,
                createdByAccountId: owner.id,
            },
        });
        const [alpha, beta] = await Promise.all([
            db.team.create({ data: { name: "Alpha Team" } }),
            db.team.create({ data: { name: "Beta Team" } }),
        ]);
        const [alphaConnection, betaConnection] = await Promise.all([
            db.teamIdentityConnection.create({
                data: {
                    teamId: alpha.id,
                    providerInstanceId: provider.id,
                    externalReference: { v: 1, kind: "github_app_identity", installationId: installation.id },
                    settings: { v: 1, kind: "github_app_identity", organizationLogin: "Acme" },
                    enabled: true,
                },
            }),
            db.teamIdentityConnection.create({
                data: {
                    teamId: beta.id,
                    providerInstanceId: provider.id,
                    externalReference: { v: 1, kind: "github_app_identity", installationId: installation.id },
                    settings: { v: 1, kind: "github_app_identity", organizationLogin: "Acme" },
                },
            }),
        ]);

        await db.teamIdentityConnection.create({ data: {
            teamId: null,
            providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "github_app_identity", installationId: installation.id },
            settings: { v: 1, kind: "github_app_identity", organizationLogin: "Acme" },
        } });

        const listed = await post(app, "/v1/identity/providers/list", owner.token, {});

        expect(listed.statusCode, listed.body).toBe(200);
        expect(listed.json()).toEqual({
            items: [{
                v: 1,
                owner: { kind: "home" },
                id: provider.id,
                callbackUrl: "https://home.example.test/v1/oauth/github-app/callback",
                kind: "github_app_identity",
                displayName: "Acme GitHub",
                enabled: false,
                firstEnabledAt: null,
                securityRevision: 1,
                revision: 1,
                config: { v: 1, kind: "github_app_identity" },
                githubAppInstallationId: installation.id,
                lastSuccessfulTest: null,
                createdByAccountId: owner.id,
                createdAt: expect.any(Number),
                updatedAt: expect.any(Number),
                teamConsumers: [
                    {
                        team: { id: alpha.id, name: "Alpha Team" },
                        binding: { kind: "identity_connection", id: alphaConnection.id, enabled: true },
                    },
                    {
                        team: { id: beta.id, name: "Beta Team" },
                        binding: { kind: "identity_connection", id: betaConnection.id, enabled: false },
                    },
                ],
            }],
            unreadableCount: 0,
        });
    });

    it("authorizes through current Home governance and rejects unknown input fields", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const member = await createAccount("member");

        expect((await post(app, "/v1/identity/providers/list", member.token, {})).statusCode).toBe(403);
        const invalid = await post(app, "/v1/identity/providers/create", owner.token, {
            displayName: "Company login",
            config,
            clientSecret: "secret",
            owner: "caller-supplied-home",
        });
        expect(invalid.statusCode, invalid.body).toBe(400);
        expect(invalid.json()).toEqual({ error: "identity_provider_invalid" });
    });

    it("answers malformed provider requests with the one typed provider error", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const paths = [
            "/v1/identity/providers/list",
            "/v1/identity/providers/create",
            "/v1/identity/providers/update",
            "/v1/identity/providers/secret/replace",
            "/v1/identity/providers/validate",
            "/v1/identity/providers/test/start",
            "/v1/identity/providers/test/consume",
            "/v1/identity/providers/enable",
            "/v1/identity/providers/disable",
            "/v1/identity/providers/remove/preflight",
            "/v1/identity/providers/remove",
        ];

        for (const path of paths) {
            const response = await post(app, path, owner.token, { unexpected: true });
            expect(response.statusCode, `${path}: ${response.body}`).toBe(400);
            expect(response.json()).toEqual({ error: "identity_provider_invalid" });
        }
    });

    it("creates, lists, edits, rotates, enables and disables without returning the secret", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const initialInvalidation = await readHomeGovernanceInvalidation(owner.id);
        const created = await post(app, "/v1/identity/providers/create", owner.token, {
            displayName: "Company login",
            config,
            clientSecret: "secret-one",
        });
        expect(created.statusCode).toBe(200);
        expect(JSON.stringify(created.json())).not.toContain("secret-one");
        expect(created.json()).toMatchObject({
            kind: "oidc",
            displayName: "Company login",
            enabled: false,
            revision: 1,
            securityRevision: 1,
            secret: { configured: true },
        });
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual({
            seq: initialInvalidation.seq + 1,
            cursor: initialInvalidation.seq + 1,
        });

        const id = created.json().id as string;
        const updated = await post(app, "/v1/identity/providers/update", owner.token, {
            id,
            expectedRevision: 1,
            displayName: "Company SSO",
        });
        expect(updated.json()).toMatchObject({ displayName: "Company SSO", revision: 2, securityRevision: 1 });
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual({
            seq: initialInvalidation.seq + 2,
            cursor: initialInvalidation.seq + 2,
        });
        const staleUpdate = await post(app, "/v1/identity/providers/update", owner.token, {
            id,
            expectedRevision: 1,
            displayName: "Stale edit",
        });
        expect(staleUpdate.statusCode).toBe(409);
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual({
            seq: initialInvalidation.seq + 2,
            cursor: initialInvalidation.seq + 2,
        });

        const rotated = await post(app, "/v1/identity/providers/secret/replace", owner.token, {
            id,
            expectedRevision: 2,
            clientSecret: "secret-two",
        });
        expect(JSON.stringify(rotated.json())).not.toContain("secret-two");
        expect(rotated.json()).toMatchObject({ revision: 3, securityRevision: 2, secret: { configured: true } });
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual({
            seq: initialInvalidation.seq + 3,
            cursor: initialInvalidation.seq + 3,
        });

        const validated = await post(app, "/v1/identity/providers/validate", owner.token, {
            id,
            expectedRevision: 3,
            expectedSecurityRevision: 2,
        });
        expect(validated.json()).toMatchObject({ id, revision: 3, securityRevision: 2 });
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual({
            seq: initialInvalidation.seq + 3,
            cursor: initialInvalidation.seq + 3,
        });

        const enabled = await post(app, "/v1/identity/providers/enable", owner.token, {
            id,
            expectedRevision: 3,
            expectedSecurityRevision: 2,
        });
        expect(enabled.json()).toMatchObject({ enabled: true, revision: 4, securityRevision: 3 });
        expect(enabled.json().firstEnabledAt).toEqual(expect.any(Number));
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual({
            seq: initialInvalidation.seq + 4,
            cursor: initialInvalidation.seq + 4,
        });

        const disabled = await post(app, "/v1/identity/providers/disable", owner.token, {
            id,
            expectedRevision: 4,
            expectedSecurityRevision: 3,
        });
        expect(disabled.json()).toMatchObject({ enabled: false, revision: 5, securityRevision: 4 });
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual({
            seq: initialInvalidation.seq + 5,
            cursor: initialInvalidation.seq + 5,
        });

        const listed = await post(app, "/v1/identity/providers/list", owner.token, {});
        expect(listed.json()).toMatchObject({
            // The redirect URI the administrator registers at the IdP is the
            // one the runtime will present; it is derived, never persisted.
            items: [{ id, displayName: "Company SSO", callbackUrl: `https://home.example.test/v1/oauth/${id}/callback` }],
            unreadableCount: 0,
        });
        expect(JSON.stringify(listed.json())).not.toContain("secret-two");
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual({
            seq: initialInvalidation.seq + 5,
            cursor: initialInvalidation.seq + 5,
        });
    });

    it("distinguishes missing and unreadable OIDC secret material without exposing ciphertext", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const created = await post(app, "/v1/identity/providers/create", owner.token, {
            displayName: "Corrupt secret provider",
            config,
            clientSecret: "secret-before-corruption",
        });
        expect(created.statusCode).toBe(200);
        const id = created.json().id as string;

        await db.identityProviderInstance.update({
            where: { id },
            data: { encryptedSecrets: null },
        });

        const missing = await post(app, "/v1/identity/providers/list", owner.token, {});
        expect(missing.statusCode).toBe(200);
        expect(missing.json()).toMatchObject({
            unreadableCount: 0,
            items: [{ id, secret: { configured: false, health: "missing" } }],
        });

        await db.identityProviderInstance.update({
            where: { id },
            data: { encryptedSecrets: Uint8Array.from([1, 2, 3]) },
        });

        const listed = await post(app, "/v1/identity/providers/list", owner.token, {});
        expect(listed.statusCode).toBe(200);
        expect(listed.json()).toMatchObject({
            unreadableCount: 0,
            items: [{ id, secret: { configured: false, health: "unreadable" } }],
        });
        expect(JSON.stringify(listed.json())).not.toContain("secret-before-corruption");
        await expect(resolveOAuthRuntimeById(process.env, id)).resolves.toBeNull();
    });

    it("reports outbound availability failures separately from endpoint-policy denials", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const created = await post(app, "/v1/identity/providers/create", owner.token, {
            displayName: "Unavailable provider",
            config,
            clientSecret: "secret-not-returned",
        });
        const provider = created.json() as { id: string; revision: number; securityRevision: number };

        discoveryCapabilities.error = new OutboundIdentityEndpointError(
            "outbound_timeout",
            "https://id.example.test/.well-known/openid-configuration",
            "secret diagnostic that must not escape",
        );
        const unavailable = await post(app, "/v1/identity/providers/validate", owner.token, {
            id: provider.id,
            expectedRevision: provider.revision,
            expectedSecurityRevision: provider.securityRevision,
        });
        expect(unavailable.statusCode).toBe(502);
        expect(unavailable.json()).toEqual({ error: "oidc_discovery_failed" });
        expect(unavailable.body).not.toContain("secret diagnostic");

        discoveryCapabilities.error = new OutboundIdentityEndpointError(
            "outbound_address_forbidden",
            "https://id.example.test/.well-known/openid-configuration",
        );
        const forbidden = await post(app, "/v1/identity/providers/validate", owner.token, {
            id: provider.id,
            expectedRevision: provider.revision,
            expectedSecurityRevision: provider.securityRevision,
        });
        expect(forbidden.statusCode).toBe(409);
        expect(forbidden.json()).toEqual({ error: "oidc_endpoint_forbidden" });
    });

    it("runs the managed OIDC lifecycle in an exact Team owner scope", async () => {
        const app = createTestApp();
        const owner = await createAccount("member");
        const outsider = await createAccount("member");
        const team = await db.team.create({ data: { name: "Scoped identity" } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: owner.id, role: "owner" },
        });
        await db.homeGovernancePolicy.upsert({
            where: { id: "home" },
            create: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
            update: {
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        const scope = { kind: "team" as const, teamId: team.id };

        expect((await post(app, "/v1/identity/providers/list", outsider.token, { owner: scope })).statusCode)
            .toBe(403);
        const created = await post(app, "/v1/identity/providers/create", owner.token, {
            owner: scope,
            displayName: "Team login",
            config,
            clientSecret: "team-secret-one",
        });
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json()).toMatchObject({ owner: scope, displayName: "Team login", revision: 1 });
        const id = created.json().id as string;

        const updated = await post(app, "/v1/identity/providers/update", owner.token, {
            owner: scope,
            id,
            expectedRevision: 1,
            displayName: "Team SSO",
        });
        expect(updated.json()).toMatchObject({ owner: scope, displayName: "Team SSO", revision: 2 });
        const rotated = await post(app, "/v1/identity/providers/secret/replace", owner.token, {
            owner: scope,
            id,
            expectedRevision: 2,
            clientSecret: "team-secret-two",
        });
        expect(rotated.json()).toMatchObject({ owner: scope, revision: 3, securityRevision: 2 });
        expect(JSON.stringify(rotated.json())).not.toContain("team-secret-two");

        const validated = await post(app, "/v1/identity/providers/validate", owner.token, {
            owner: scope,
            id,
            expectedRevision: 3,
            expectedSecurityRevision: 2,
        });
        expect(validated.statusCode, validated.body).toBe(200);
        const enabled = await post(app, "/v1/identity/providers/enable", owner.token, {
            owner: scope,
            id,
            expectedRevision: 3,
            expectedSecurityRevision: 2,
        });
        expect(enabled.statusCode, enabled.body).toBe(200);
        expect(enabled.json()).toMatchObject({ owner: scope, enabled: true, revision: 4, securityRevision: 3 });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: id,
                externalReference: { v: 1, kind: "oidc" },
                settings: {
                    v: 1,
                    kind: "oidc",
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
                enabled: true,
                firstEnabledAt: new Date("2026-09-06T00:00:00.000Z"),
            },
        });
        const runtime = await resolveOAuthRuntimeById(
            process.env,
            id,
            scope,
            "identity_connection_test",
        );
        const identity = await db.accountIdentity.create({
            data: { accountId: owner.id, provider: id, providerUserId: "team-owner-subject" },
        });
        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "team_connection", connectionId: connection.id }],
                },
            },
        });
        const unqualifiedList = await post(app, "/v1/identity/providers/list", owner.token, { owner: scope });
        // The enabled, connected provider is currently usable, but this exact
        // credential has not supplied qualifying evidence for the Team policy.
        expect(unqualifiedList.statusCode).toBe(403);
        expect(unqualifiedList.json()).toEqual({ error: "team_authentication_required" });
        const qualifiedAutomationToken = await auth.createToken(owner.id, undefined, {
            kind: "terminal",
            authority: "account_automation",
            authenticationEvidence: [{
                kind: "provider",
                providerId: id,
                identityId: identity.id,
                runtimeFingerprint: runtime!.reference.runtimeFingerprint,
                teamConnectionId: connection.id,
            }],
        });
        const started = await post(app, "/v1/identity/providers/test/start", qualifiedAutomationToken, {
            owner: scope,
            id,
            expectedRevision: 4,
            expectedSecurityRevision: 3,
        });
        expect(started.statusCode, started.body).toBe(200);
        expect(started.headers["cache-control"]).toBe("no-store");
        const testedAt = new Date("2026-09-06T03:00:00.000Z");
        const diagnostics = {
            subjectPresent: true, loginAvailable: true, emailAvailable: false, emailVerified: false,
            groups: { state: "absent" as const, count: null },
            eligibility: { status: "eligible" as const, rules: [] },
            mappedGroups: [],
        };
        const result = await createIdentityConnectionTestResult({
            initiatorAccountId: owner.id,
            securityBinding: {
                provider: runtime!.reference,
                connection: null,
                admission: null,
                purpose: "identity_connection_test",
            },
            diagnostics,
            providerUserId: "team-subject-do-not-return",
            testedAt,
            expiresAt: new Date(Date.now() + 60_000),
        });
        const consumed = await post(app, "/v1/identity/providers/test/consume", qualifiedAutomationToken, {
            owner: scope,
            id,
            resultHandle: result.resultHandle,
        });
        expect(consumed.statusCode, consumed.body).toBe(200);
        expect(consumed.headers["cache-control"]).toBe("no-store");
        expect(consumed.json()).toMatchObject({
            provider: { owner: scope, id, lastSuccessfulTest: { current: true } },
            diagnostics,
            testedAt: testedAt.getTime(),
            subjectPresent: true,
        });
        expect(JSON.stringify(consumed.json())).not.toContain("team-subject-do-not-return");
        await db.teamIdentityConnection.update({
            where: { id: connection.id },
            data: { enabled: false },
        });
        const unavailableList = await post(app, "/v1/identity/providers/list", qualifiedAutomationToken, { owner: scope });
        expect(unavailableList.statusCode).toBe(503);
        expect(unavailableList.json()).toEqual({ error: "team_authentication_unavailable" });
        await db.team.update({
            where: { id: team.id },
            data: { authenticationPolicy: null },
        });
        const disabled = await post(app, "/v1/identity/providers/disable", owner.token, {
            owner: scope,
            id,
            expectedRevision: 4,
            expectedSecurityRevision: 3,
        });
        expect(disabled.json()).toMatchObject({ owner: scope, enabled: false, revision: 5 });
        const listed = await post(app, "/v1/identity/providers/list", owner.token, { owner: scope });
        expect(listed.json()).toMatchObject({
            items: [{ id, owner: scope, displayName: "Team SSO", teamConsumers: [] }],
        });
        expect((await post(app, "/v1/identity/providers/remove", owner.token, {
            owner: scope,
            id,
            expectedRevision: 5,
        })).json()).toEqual({
            error: "identity_provider_in_use",
            blockers: { identityCount: 1, connectionCount: 1 },
        });
        await db.teamIdentityConnection.delete({ where: { id: connection.id } });
        await db.accountIdentity.delete({ where: { id: identity.id } });
        expect((await post(app, "/v1/identity/providers/remove", owner.token, {
            owner: scope,
            id,
            expectedRevision: 5,
        })).json()).toEqual({ outcome: "removed" });
        await expect(db.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId: owner.id,
                    kind: "account",
                    entityId: "home-governance",
                },
            },
        })).resolves.toBeNull();
    });

    it("preflights identity blockers and rechecks them before removal", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const linked = await createAccount("member");
        const created = await post(app, "/v1/identity/providers/create", owner.token, {
            displayName: "Company login", config, clientSecret: "secret",
        });
        const id = created.json().id as string;
        const afterCreate = await readHomeGovernanceInvalidation(owner.id);
        await db.accountIdentity.create({
            data: {
                accountId: linked.id,
                provider: id,
                providerUserId: "subject-1",
                providerLogin: "linked-user",
                profile: { sub: "subject-1" },
            },
        });

        const preflight = await post(app, "/v1/identity/providers/remove/preflight", owner.token, {
            id, expectedRevision: 1,
        });
        expect(preflight.json()).toMatchObject({
            canRemove: false,
            blockers: { identityCount: 1, connectionCount: 0, affectedAccountIds: [linked.id] },
        });
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual(afterCreate);
        expect((await post(app, "/v1/identity/providers/remove", owner.token, {
            id, expectedRevision: 1,
        })).json()).toMatchObject({ error: "identity_provider_in_use" });
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual(afterCreate);

        await db.accountIdentity.deleteMany({ where: { provider: id } });
        expect((await post(app, "/v1/identity/providers/remove", owner.token, {
            id, expectedRevision: 1,
        })).json()).toEqual({ outcome: "removed" });
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual({
            seq: afterCreate.seq + 1,
            cursor: afterCreate.seq + 1,
        });
    });

    it("uses the shared one-time OAuth test result without linking an identity", async () => {
        const app = createTestApp();
        const owner = await createAccount("owner");
        const unsupported = await post(app, "/v1/identity/providers/create", owner.token, {
            displayName: "No PKCE", config, clientSecret: "secret",
        });
        discoveryCapabilities.pkceS256 = false;
        const rejected = await post(app, "/v1/identity/providers/test/start", owner.token, {
            id: unsupported.json().id,
            expectedRevision: 1,
            expectedSecurityRevision: 1,
        });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json()).toEqual({ error: "identity_provider_invalid" });

        discoveryCapabilities.pkceS256 = true;
        const created = await post(app, "/v1/identity/providers/create", owner.token, {
            displayName: "Testable", config: { ...config, issuer: "https://testable.example.test" }, clientSecret: "secret",
        });
        const id = created.json().id as string;
        const beforeStart = await readHomeGovernanceInvalidation(owner.id);
        const started = await post(app, "/v1/identity/providers/test/start", owner.token, {
            id,
            expectedRevision: 1,
            expectedSecurityRevision: 1,
        });
        expect(started.statusCode).toBe(200);
        expect(started.json()).toMatchObject({ authorizeUrl: expect.stringContaining("https://"), attemptId: expect.any(String) });
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual(beforeStart);
        const beforeConsume = await readHomeGovernanceInvalidation(owner.id);

        const runtime = await resolveOAuthRuntimeById(
            process.env,
            id,
            HOME_PROVIDER_CONTEXT,
            "identity_connection_test",
        );
        const testedAt = new Date("2026-09-06T02:00:00.000Z");
        const result = await createIdentityConnectionTestResult({
            initiatorAccountId: owner.id,
            securityBinding: {
                provider: runtime!.reference,
                connection: null,
                admission: null,
                purpose: "identity_connection_test",
            },
            providerUserId: "subject-do-not-return",
            testedAt,
            expiresAt: new Date(Date.now() + 60_000),
        });
        const consumed = await post(app, "/v1/identity/providers/test/consume", owner.token, {
            id,
            resultHandle: result.resultHandle,
        });
        expect(consumed.json()).toMatchObject({
            provider: {
                id,
                lastSuccessfulTest: {
                    at: testedAt.getTime(),
                    testedSecurityRevision: 1,
                    current: true,
                },
            },
            testedAt: testedAt.getTime(),
            subjectPresent: true,
        });
        expect(JSON.stringify(consumed.json())).not.toContain("subject-do-not-return");
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual({
            seq: beforeConsume.seq + 1,
            cursor: beforeConsume.seq + 1,
        });
        await expect(db.accountIdentity.count({ where: { provider: id } })).resolves.toBe(0);
        const afterConsume = await readHomeGovernanceInvalidation(owner.id);
        expect((await post(app, "/v1/identity/providers/test/consume", owner.token, {
            id,
            resultHandle: result.resultHandle,
        })).statusCode).toBe(400);
        expect(await readHomeGovernanceInvalidation(owner.id)).toEqual(afterConsume);

        const rotated = await post(app, "/v1/identity/providers/secret/replace", owner.token, {
            id,
            expectedRevision: 1,
            clientSecret: "rotated-secret",
        });
        expect(rotated.json()).toMatchObject({
            securityRevision: 2,
            lastSuccessfulTest: {
                at: testedAt.getTime(),
                testedSecurityRevision: 1,
                current: false,
            },
        });
    });
});
