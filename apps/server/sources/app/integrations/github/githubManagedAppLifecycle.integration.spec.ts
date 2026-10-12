import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const githubMocks = vi.hoisted(() => ({
    app: vi.fn(),
    appRequest: vi.fn(),
    installationOctokit: vi.fn(),
    installationRequest: vi.fn(),
}));

vi.mock("octokit", () => ({
    App: githubMocks.app,
    Octokit: Object.assign(githubMocks.installationOctokit, {
        defaults: vi.fn(() => githubMocks.installationOctokit),
    }),
}));

import { resolveHomeGovernanceAuthority } from "@/app/home/governance/homeCapabilities";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { resolveManagedIdentityNetworkPolicyInTx } from "@/app/auth/providers/managed/managedIdentityNetworkPolicy";
import { readIdentityProviderInstanceInTx } from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import {
    listHomeManagedIdentityProviders,
    replaceHomeManagedIdentityProviderSecret,
    setHomeManagedIdentityProviderEnabled,
    updateHomeManagedIdentityProvider,
    validateHomeManagedIdentityProvider,
} from "@/app/home/governance/homeManagedIdentityProviders";
import { createTeamIdentityConnectionForActor } from "@/app/teams/identity/teamIdentityConnectionAdministration";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createGitHubAppRegistration,
    createHomeGitHubAppRegistration,
    listGitHubAppRegistrations,
    removeHomeGitHubAppInstallation,
    readGitHubAppRegistrationRuntime,
    updateGitHubAppRegistration,
    updateHomeGitHubAppRegistration,
    verifyGitHubAppInstallationWithAdministratorProfile,
    verifyHomeGitHubAppInstallation,
} from "./githubManagedAppLifecycle";
import { isManagedGitHubIdentityProviderAvailableForConnectionInTx } from "./githubManagedIdentityProvider";
import { beginManagedGitHubDirectoryRead } from "./githubManagedDirectory";
import { TEAM_CHANGE_ENTITY_ID } from "@/app/teams/teamChanges";
import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import { listHomeAdministrationEventsInTx } from "@/app/home/audit/homeAdministrationEvents";

const ACCEPTED_EMAIL_PASSWORD = { kind: "home_method" as const, methodId: "email_password" };
const EMAIL_PASSWORD_EVIDENCE = [ACCEPTED_EMAIL_PASSWORD];
const HOME_OFFERS_EMAIL_PASSWORD = {
    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
    HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
};

let harness: LightSqliteHarness;
let sequence = 0;

async function createAccount(homeRole: "owner" | "admin" | "member" = "owner"): Promise<string> {
    sequence += 1;
    const account = await db.account.create({
        data: { publicKey: `managed-github-${sequence}`, homeRole, status: "active" },
        select: { id: true },
    });
    await db.accountIdentity.create({
        data: {
            accountId: account.id,
            provider: "github",
            providerUserId: String(500 + sequence),
            providerLogin: `github-admin-${sequence}`,
            profile: { id: 500 + sequence, login: `github-admin-${sequence}` },
        },
    });
    return account.id;
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-managed-github-app-",
        initAuth: false,
        initEncrypt: true,
        initFiles: false,
    });
});
beforeEach(() => {
    githubMocks.app.mockImplementation(() => ({ octokit: { request: githubMocks.appRequest } }));
    githubMocks.installationOctokit.mockImplementation(() => ({ request: githubMocks.installationRequest }));
    githubMocks.appRequest.mockImplementation(async (route: string) => ({
        data: route.startsWith("POST ")
            ? { token: "installation-token" }
            : {
                id: 301,
                app_id: 44,
                account: { id: 401, login: "Acme", type: "Organization" },
                repository_selection: "selected",
                permissions: { members: "read" },
                events: [],
                suspended_at: null,
            },
    }));
    githubMocks.installationRequest.mockImplementation(async (_route: string, input: { username: string }) => ({
        data: {
            state: "active",
            role: "admin",
            user: { id: Number(input.username.replace("github-admin-", "")) + 500 },
        },
    }));
});
afterAll(async () => await harness.close());
afterEach(async () => {
    await db.homeAdministrationEvent.deleteMany({});
    await db.teamDirectorySource.deleteMany({});
    await db.teamIdentityConnection.deleteMany({});
    await db.identityProviderInstance.deleteMany({});
    await db.gitHubAppInstallation.deleteMany({});
    await db.gitHubAppRegistration.deleteMany({});
    await db.teamMembership.deleteMany({});
    await db.team.deleteMany({});
    await db.accountIdentity.deleteMany({});
    await db.accountPasswordCredential.deleteMany({});
    await db.account.deleteMany({});
    await db.homeGovernancePolicy.deleteMany({});
});

describe("managed GitHub App registration lifecycle", () => {
    it("requires an exact Home-approved origin for a Home-owned GitHub Enterprise App", async () => {
        const actorAccountId = await createAccount("owner");
        const input = {
            githubHost: "https://github.home-enterprise.example",
            githubAppId: 44n,
            githubClientId: "Iv1.home-enterprise",
            secrets: { v: 1 as const, privateKey: "home-enterprise-private-key" },
        };

        await expect(createGitHubAppRegistration({
            actorAccountId,
            owner: { kind: "home" },
            input,
        })).resolves.toEqual({ status: "github_enterprise_origin_not_approved" });

        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["github_app_identity"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [input.githubHost],
                },
            },
        });

        await expect(createGitHubAppRegistration({
            actorAccountId,
            owner: { kind: "home" },
            input,
        })).resolves.toMatchObject({
            status: "created",
            registration: { owner: { kind: "home" }, githubHost: input.githubHost },
        });
    });

    it("invalidates a Team when its Home-owned GitHub App registration changes", async () => {
        const actorAccountId = await createAccount("owner");
        const directoryMemberAccountId = await createAccount("member");
        const created = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 144n,
                githubClientId: "Iv1.shared-home-app",
                secrets: { v: 1, privateKey: "shared-home-private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected created registration");
        const team = await db.team.create({ data: { name: "Shared Home GitHub consumer" } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: actorAccountId, role: "owner", status: "active" },
        });
        const installation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: created.registration.id,
                githubInstallationId: 145n,
                githubOrganizationId: 146n,
                githubOrganizationLogin: "SharedHome",
                repositorySelection: "all",
                state: "verified",
            },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: null,
                kind: "github_app_identity",
                displayName: "SharedHome GitHub",
                config: { v: 1, kind: "github_app_identity" },
                githubAppInstallationId: installation.id,
            },
        });
        const identityConnection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: {
                    v: 1,
                    kind: "github_app_identity",
                    installationId: installation.id,
                },
                settings: {
                    v: 1,
                    kind: "github_app_identity",
                    organizationLogin: "SharedHome",
                },
            },
        });
        const directoryTeam = await db.team.create({ data: { name: "Shared Home GitHub directory consumer" } });
        await db.teamMembership.create({
            data: {
                teamId: directoryTeam.id,
                accountId: directoryMemberAccountId,
                role: "member",
                status: "active",
            },
        });
        const directorySource = await db.teamDirectorySource.create({
            data: {
                teamId: directoryTeam.id,
                kind: "github_organization",
                state: "active",
                displayName: "SharedHome directory",
                externalSourceKey: "github:shared-home",
                bindingConfig: {
                    v: 1,
                    kind: "github_organization",
                    githubOrganizationLogin: "SharedHome",
                },
                githubAppInstallationId: installation.id,
            },
        });

        await db.teamIdentityConnection.create({ data: {
            teamId: null,
            providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "github_app_identity", installationId: installation.id },
            settings: { v: 1, kind: "github_app_identity", organizationLogin: "SharedHome" },
        } });

        const listed = await listGitHubAppRegistrations({
            actorAccountId,
            owner: { kind: "home" },
        });
        expect(listed).toMatchObject({
            status: "ready",
            installations: [{
                id: installation.id,
                teamConsumers: [
                    {
                        team: { id: team.id, name: "Shared Home GitHub consumer" },
                        binding: {
                            kind: "identity_connection",
                            id: identityConnection.id,
                            providerInstanceId: provider.id,
                            enabled: false,
                        },
                    },
                    {
                        team: { id: directoryTeam.id, name: "Shared Home GitHub directory consumer" },
                        binding: {
                            kind: "directory_source",
                            id: directorySource.id,
                            state: "active",
                        },
                    },
                ],
            }],
        });

        await expect(updateHomeGitHubAppRegistration({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRevision: created.registration.revision,
            patch: { githubAppSlug: "shared-home" },
        })).resolves.toMatchObject({ status: "updated" });

        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: actorAccountId,
                    kind: "account",
                    entityId: TEAM_CHANGE_ENTITY_ID,
                },
            },
        })).resolves.toMatchObject({ cursor: expect.any(Number) });
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: directoryMemberAccountId,
                    kind: "account",
                    entityId: TEAM_CHANGE_ENTITY_ID,
                },
            },
        })).resolves.toMatchObject({ cursor: expect.any(Number) });
    });

    it("separates enabled requirements from draft setup and paused-source repair requirements", async () => {
        const actorAccountId = await createAccount("owner");
        const created = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 180n,
                githubClientId: "Iv1.home-signin",
                secrets: { v: 1, privateKey: "home-signin-private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected created registration");
        const installation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: created.registration.id,
                githubInstallationId: 181n,
                githubOrganizationId: 182n,
                githubOrganizationLogin: "HomeSignIn",
                repositorySelection: "all",
                state: "verified",
                verifiedPermissions: {},
                verifiedEvents: [],
            },
        });
        // A disabled Home provider still needs setup guidance, but is not a current consumer.
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: null,
                kind: "github_app_identity",
                displayName: "HomeSignIn GitHub",
                config: { v: 1, kind: "github_app_identity" },
                githubAppInstallationId: installation.id,
            },
        });

        await expect(listGitHubAppRegistrations({
            actorAccountId,
            owner: { kind: "home" },
        })).resolves.toMatchObject({
            status: "ready",
            installations: [{
                id: installation.id,
                teamConsumers: [],
                requirements: { permissions: {}, events: [], missingPermissions: [], missingEvents: [] },
                prospectiveRequirements: {
                    permissions: { members: "read" },
                    missingPermissions: [{ permission: "members", required: "read" }],
                },
            }],
        });

        // Home sign-in has no Team connection: enabling the provider is sufficient.
        await db.identityProviderInstance.update({ where: { id: provider.id }, data: { enabled: true } });
        await expect(listGitHubAppRegistrations({ actorAccountId, owner: { kind: "home" } }))
            .resolves.toMatchObject({ installations: [{
                requirements: { permissions: { members: "read" } },
                prospectiveRequirements: { permissions: { members: "read" } },
            }] });

        await db.identityProviderInstance.delete({ where: { id: provider.id } });
        const team = await db.team.create({ data: { name: "Paused directory" } });
        const source = await db.teamDirectorySource.create({ data: {
            teamId: team.id,
            kind: "github_organization",
            state: "paused",
            displayName: "Paused GitHub directory",
            externalSourceKey: "github:paused",
            bindingConfig: { v: 1, kind: "github_organization", githubOrganizationLogin: "HomeSignIn" },
            githubAppInstallationId: installation.id,
        } });
        await expect(listGitHubAppRegistrations({ actorAccountId, owner: { kind: "home" } }))
            .resolves.toMatchObject({ installations: [{
                requirements: { permissions: {}, events: [], missingPermissions: [], missingEvents: [] },
                prospectiveRequirements: { permissions: { members: "read" } },
            }] });
        await db.teamDirectorySource.update({ where: { id: source.id }, data: { state: "active" } });
        await expect(listGitHubAppRegistrations({ actorAccountId, owner: { kind: "home" } }))
            .resolves.toMatchObject({ installations: [{ requirements: { permissions: { members: "read" } } }] });
    });

    it("withdraws verification, identity, and directory readiness when Home removes a GHES origin", async () => {
        const actorAccountId = await createAccount("owner");
        const githubHost = "https://github.current-origin.example";
        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["github_app_identity"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [githubHost],
                },
            },
        });
        const created = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost,
                githubAppId: 44n,
                githubClientId: "Iv1.current-origin",
                secrets: {
                    v: 1,
                    clientSecret: "current-origin-client-secret",
                    privateKey: "current-origin-private-key",
                },
            },
        });
        if (created.status !== "created") throw new Error("expected created registration");
        const network = await inTx(async (tx) => await resolveManagedIdentityNetworkPolicyInTx(tx, {
            env: process.env,
            timeoutSeconds: 30,
        }));
        githubMocks.installationRequest.mockResolvedValue({
            data: { state: "active", role: "admin", user: { id: 900 } },
        });
        const verified = await verifyGitHubAppInstallationWithAdministratorProfile({
            actorAccountId,
            owner: { kind: "home" },
            registrationId: created.registration.id,
            expectedRegistrationRevision: created.registration.revision,
            expectedRegistrationSecurityRevision: created.registration.securityRevision,
            expectedInstallationRevision: 0,
            expectedNetworkPolicyFingerprint: network.fingerprint,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
            administrator: { githubUserId: 900n, githubUserLogin: "enterprise-admin" },
        });
        if (verified.status !== "verified") throw new Error("expected verified installation");
        const providerRow = await db.identityProviderInstance.findFirstOrThrow({
            where: { githubAppInstallationId: verified.installation.id },
        });
        const provider = await inTx(async (tx) => await readIdentityProviderInstanceInTx(tx, {
            id: providerRow.id,
            owner: { kind: "home" },
        }));
        if (provider.status !== "ready") throw new Error("expected ready identity provider");
        const team = await db.team.create({ data: { name: "Current-origin directory" } });
        const source = await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "github_organization",
                state: "initializing",
                displayName: "Current-origin directory",
                externalSourceKey: "github:current-origin",
                bindingConfig: { v: 1, kind: "github_organization", githubOrganizationLogin: "Acme" },
                githubAppInstallationId: verified.installation.id,
            },
        });
        await expect(inTx(async (tx) => await isManagedGitHubIdentityProviderAvailableForConnectionInTx(tx, {
            env: process.env,
            context: { kind: "home" },
            provider: provider.instance,
        }))).resolves.toBe(true);
        await expect(beginManagedGitHubDirectoryRead({ directorySourceId: source.id }))
            .resolves.toMatchObject({ ok: true });
        const appRequestCountBeforeWithdrawal = githubMocks.appRequest.mock.calls.length;
        const installationRequestCountBeforeWithdrawal = githubMocks.installationRequest.mock.calls.length;

        await db.homeGovernancePolicy.update({
            where: { id: "home" },
            data: {
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["github_app_identity"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });

        await expect(updateHomeGitHubAppRegistration({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRevision: 2,
            patch: { githubAppSlug: "still-current" },
        })).resolves.toEqual({ status: "github_enterprise_origin_not_approved" });
        await expect(verifyGitHubAppInstallationWithAdministratorProfile({
            actorAccountId,
            owner: { kind: "home" },
            registrationId: created.registration.id,
            expectedRegistrationRevision: 2,
            expectedRegistrationSecurityRevision: created.registration.securityRevision,
            expectedInstallationRevision: 1,
            expectedNetworkPolicyFingerprint: network.fingerprint,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
            administrator: { githubUserId: 900n, githubUserLogin: "enterprise-admin" },
        })).resolves.toEqual({ status: "github_enterprise_origin_not_approved" });
        await expect(inTx(async (tx) => await isManagedGitHubIdentityProviderAvailableForConnectionInTx(tx, {
            env: process.env,
            context: { kind: "home" },
            provider: provider.instance,
        }))).resolves.toBe(false);
        await expect(beginManagedGitHubDirectoryRead({ directorySourceId: source.id }))
            .resolves.toEqual({ ok: false, code: "installation_unavailable" });
        expect(githubMocks.appRequest).toHaveBeenCalledTimes(appRequestCountBeforeWithdrawal);
        expect(githubMocks.installationRequest).toHaveBeenCalledTimes(installationRequestCountBeforeWithdrawal);
    });

    it("holds a restricted Team's own App management to the Team's accepted credential", async () => {
        const actorAccountId = await createAccount("member");
        await db.accountIdentity.create({
            data: {
                accountId: actorAccountId,
                provider: "email",
                providerUserId: `restricted-admin-${actorAccountId}@example.test`,
                profile: {},
            },
        });
        await db.accountPasswordCredential.create({
            data: {
                accountId: actorAccountId,
                credential: {
                    v: 1,
                    kind: "plain_password_hash",
                    hash: await hashPasswordMaterial(new TextEncoder().encode("restricted admin factor")),
                },
            },
        });
        const team = await db.team.create({
            data: {
                name: "Restricted identity administration",
                authenticationPolicy: { v: 1, mode: "restricted", accepted: [ACCEPTED_EMAIL_PASSWORD] },
            },
        });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actorAccountId, role: "owner" } });
        const owner = { kind: "team" as const, teamId: team.id };
        const unqualified = {
            env: { ...process.env, ...HOME_OFFERS_EMAIL_PASSWORD },
            authenticationAuthority: "present_user" as const,
        };
        const qualified = { ...unqualified, authenticationEvidence: EMAIL_PASSWORD_EVIDENCE };
        const input = {
            githubHost: "https://github.com",
            githubAppId: 63n,
            githubClientId: "Iv1.restricted",
            secrets: { v: 1 as const, privateKey: "restricted-private-key" },
        };

        // The actor IS this Team's owner; only the credential the restricted
        // policy accepts is missing. That is a recoverable authentication
        // outcome, so it travels as itself rather than collapsing into the
        // capability refusal a non-administrator gets.
        await expect(createGitHubAppRegistration({ ...unqualified, actorAccountId, owner, input }))
            .resolves.toEqual({ status: "team_authentication_required" });
        await expect(db.gitHubAppRegistration.count()).resolves.toBe(0);
        await expect(listGitHubAppRegistrations({ ...unqualified, actorAccountId, owner }))
            .resolves.toEqual({ status: "team_authentication_required" });

        const created = await createGitHubAppRegistration({ ...qualified, actorAccountId, owner, input });
        expect(created).toMatchObject({ status: "created", registration: { githubAppId: 63n } });
        if (created.status !== "created") throw new Error("expected created registration");
        await expect(listGitHubAppRegistrations({ ...qualified, actorAccountId, owner }))
            .resolves.toMatchObject({ status: "ready", registrations: [{ githubAppId: 63n }] });
        await expect(updateGitHubAppRegistration({
            ...unqualified,
            actorAccountId,
            owner,
            registrationId: created.registration.id,
            expectedRevision: created.registration.revision,
            patch: { githubAppSlug: "unqualified-edit" },
        })).resolves.toEqual({ status: "team_authentication_required" });
        await expect(db.gitHubAppRegistration.findUniqueOrThrow({ where: { id: created.registration.id } }))
            .resolves.toMatchObject({ revision: 1, githubAppSlug: null });

        // Home-owned management is a separate authority and never consumes a
        // Team's credential policy.
        const homeAdminAccountId = await createAccount("owner");
        await expect(createHomeGitHubAppRegistration({
            actorAccountId: homeAdminAccountId,
            input: { ...input, githubAppId: 64n, githubClientId: "Iv1.home-unqualified" },
        })).resolves.toMatchObject({ status: "created" });
    });

    it("lets a current Team administrator create and list only its Team-owned Apps", async () => {
        const actorAccountId = await createAccount("member");
        const otherActorAccountId = await createAccount("member");
        const team = await db.team.create({ data: { name: "Managed identity" } });
        const otherTeam = await db.team.create({ data: { name: "Other managed identity" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: actorAccountId, role: "admin" },
            { teamId: otherTeam.id, accountId: otherActorAccountId, role: "admin" },
        ] });

        const created = await createGitHubAppRegistration({
            actorAccountId,
            owner: { kind: "team", teamId: team.id },
            input: {
                githubHost: "https://github.com",
                githubAppId: 45n,
                githubClientId: "Iv1.team",
                secrets: { v: 1, privateKey: "team-private-key" },
            },
        });
        expect(created).toMatchObject({
            status: "created",
            registration: { owner: { kind: "team", teamId: team.id }, githubAppId: 45n },
        });
        if (created.status !== "created") throw new Error("expected created registration");
        const installation = await db.gitHubAppInstallation.create({
            data: {
                registrationId: created.registration.id,
                githubInstallationId: 46n,
                githubOrganizationId: 47n,
                githubOrganizationLogin: "TeamOwned",
                repositorySelection: "all",
                state: "verified",
            },
        });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: "github_app_identity",
                displayName: "Team-owned GitHub",
                enabled: true,
                config: { v: 1, kind: "github_app_identity" },
                githubAppInstallationId: installation.id,
            },
        });
        await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                enabled: true,
                externalReference: {
                    v: 1,
                    kind: "github_app_identity",
                    installationId: installation.id,
                },
                settings: {
                    v: 1,
                    kind: "github_app_identity",
                    organizationLogin: "TeamOwned",
                },
            },
        });
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: actorAccountId,
                    kind: "account",
                    entityId: TEAM_CHANGE_ENTITY_ID,
                },
            },
        })).resolves.toMatchObject({ cursor: 1 });
        await expect(listGitHubAppRegistrations({
            actorAccountId,
            owner: { kind: "team", teamId: team.id },
        })).resolves.toMatchObject({
            status: "ready",
            registrations: [{ githubAppId: 45n }],
            // A Team-owned App's own identity consumers decide what it must be
            // granted; the Home-owned filter must not hide them from its Team.
            installations: [{
                id: installation.id,
                teamConsumers: [],
                requirements: { permissions: { members: "read" }, missingPermissions: [{ permission: "members", required: "read" }] },
            }],
        });
        await expect(listGitHubAppRegistrations({
            actorAccountId: otherActorAccountId,
            owner: { kind: "team", teamId: team.id },
        })).resolves.toEqual({ status: "forbidden" });

        await db.teamIdentityConnection.updateMany({
            where: { providerInstanceId: provider.id }, data: { enabled: false },
        });
        await expect(listGitHubAppRegistrations({ actorAccountId, owner: { kind: "team", teamId: team.id } }))
            .resolves.toMatchObject({ installations: [{
                requirements: { permissions: {}, events: [], missingPermissions: [], missingEvents: [] },
                prospectiveRequirements: { permissions: { members: "read" } },
            }] });

        await expect(updateGitHubAppRegistration({
            actorAccountId,
            owner: { kind: "team", teamId: team.id },
            registrationId: created.registration.id,
            expectedRevision: created.registration.revision,
            patch: { githubAppSlug: "team-managed-app" },
        })).resolves.toMatchObject({
            status: "updated",
            registration: {
                owner: { kind: "team", teamId: team.id },
                revision: 2,
                securityRevision: 1,
                githubAppSlug: "team-managed-app",
            },
        });
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: actorAccountId,
                    kind: "account",
                    entityId: TEAM_CHANGE_ENTITY_ID,
                },
            },
        })).resolves.toMatchObject({ cursor: 2 });
        await expect(updateGitHubAppRegistration({
            actorAccountId: otherActorAccountId,
            owner: { kind: "team", teamId: team.id },
            registrationId: created.registration.id,
            expectedRevision: 2,
            patch: { githubAppSlug: "unauthorized-edit" },
        })).resolves.toEqual({ status: "forbidden" });
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: actorAccountId,
                    kind: "account",
                    entityId: TEAM_CHANGE_ENTITY_ID,
                },
            },
        })).resolves.toMatchObject({ cursor: 2 });
    });

    it("requires an exact Home-approved origin for a Team-owned GitHub Enterprise App", async () => {
        const actorAccountId = await createAccount("member");
        const team = await db.team.create({ data: { name: "Enterprise identity" } });
        await db.teamMembership.create({
            data: { teamId: team.id, accountId: actorAccountId, role: "admin" },
        });
        const input = {
            githubHost: "https://github.enterprise.example",
            githubAppId: 46n,
            githubClientId: "Iv1.enterprise",
            secrets: {
                v: 1 as const,
                clientSecret: "team-enterprise-client-secret",
                privateKey: "team-enterprise-private-key",
            },
        };

        await expect(createGitHubAppRegistration({
            actorAccountId,
            owner: { kind: "team", teamId: team.id },
            input,
        })).resolves.toEqual({ status: "github_enterprise_origin_not_approved" });

        await db.homeGovernancePolicy.create({
            data: {
                id: "home",
                teamCreationPolicy: "managed_only",
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["github_app_identity"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: ["https://github.enterprise.example"],
                },
            },
        });

        const created = await createGitHubAppRegistration({
            actorAccountId,
            owner: { kind: "team", teamId: team.id },
            input,
        });
        expect(created).toMatchObject({ status: "created", registration: { githubHost: input.githubHost } });
        if (created.status !== "created") throw new Error("expected created registration");
        const network = await inTx(async (tx) => await resolveManagedIdentityNetworkPolicyInTx(tx, {
            env: process.env,
            timeoutSeconds: 30,
        }));
        githubMocks.appRequest.mockImplementation(async (route: string) => ({
            data: route.startsWith("POST ")
                ? { token: "installation-token" }
                : {
                    id: 301,
                    app_id: 46,
                    account: { id: 401, login: "Acme", type: "Organization" },
                    repository_selection: "selected",
                    permissions: { members: "read" },
                    events: [],
                    suspended_at: null,
                },
        }));

        await expect(verifyGitHubAppInstallationWithAdministratorProfile({
            actorAccountId,
            owner: { kind: "team", teamId: team.id },
            registrationId: created.registration.id,
            expectedRegistrationRevision: created.registration.revision,
            expectedRegistrationSecurityRevision: created.registration.securityRevision,
            expectedInstallationRevision: 0,
            expectedNetworkPolicyFingerprint: network.fingerprint,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
            administrator: { githubUserId: 501n, githubUserLogin: "github-admin-1" },
        })).resolves.toMatchObject({ status: "verified", installation: { state: "verified" } });

        const provider = await db.identityProviderInstance.findFirstOrThrow({
            where: { ownerTeamId: team.id, githubAppInstallationId: { not: null } },
        });
        expect(provider).toMatchObject({
            kind: "github_app_identity",
            displayName: "Acme GitHub",
            enabled: false,
            config: { v: 1, kind: "github_app_identity" },
        });
        if (!provider.githubAppInstallationId) throw new Error("expected managed GitHub installation reference");
        await expect(db.teamIdentityConnection.findUnique({
            where: { teamId_providerInstanceId: { teamId: team.id, providerInstanceId: provider.id } },
        })).resolves.toBeNull();
        await expect(createTeamIdentityConnectionForActor({
            v: 1,
            actorAccountId,
            teamId: team.id,
            providerInstanceId: provider.id,
            externalReference: {
                v: 1,
                kind: "github_app_identity",
                installationId: provider.githubAppInstallationId,
            },
            settings: { v: 1, kind: "github_app_identity", organizationLogin: "Different" },
            env: process.env,
        })).resolves.toEqual({ ok: false, error: "identity_connection_invalid" });
        await expect(db.identityProviderInstance.findUniqueOrThrow({ where: { id: provider.id } }))
            .resolves.toMatchObject({ enabled: false });
        await expect(db.teamIdentityConnection.findUnique({
            where: { teamId_providerInstanceId: { teamId: team.id, providerInstanceId: provider.id } },
        })).resolves.toBeNull();
        const bindingInput = {
            v: 1 as const,
            actorAccountId,
            teamId: team.id,
            providerInstanceId: provider.id,
            externalReference: {
                v: 1 as const,
                kind: "github_app_identity" as const,
                installationId: provider.githubAppInstallationId,
            },
            settings: { v: 1 as const, kind: "github_app_identity" as const, organizationLogin: "Acme" },
            env: process.env,
        };
        const bound = await createTeamIdentityConnectionForActor(bindingInput);
        expect(bound).toMatchObject({ ok: true, value: { enabled: false } });
        await expect(db.identityProviderInstance.findUniqueOrThrow({ where: { id: provider.id } }))
            .resolves.toMatchObject({ enabled: true });
        await expect(createTeamIdentityConnectionForActor(bindingInput)).resolves.toEqual(bound);
        await expect(db.teamIdentityConnection.count({
            where: { teamId: team.id, providerInstanceId: provider.id },
        })).resolves.toBe(1);
        await expect(listHomeManagedIdentityProviders({
            actorAccountId,
            owner: { kind: "team", teamId: team.id },
        })).resolves.toEqual({ status: "forbidden" });
        await expect(setHomeManagedIdentityProviderEnabled({
            actorAccountId,
            owner: { kind: "team", teamId: team.id },
            id: provider.id,
            expectedRevision: provider.revision,
            expectedSecurityRevision: provider.securityRevision,
            enabled: false,
        })).resolves.toEqual({ status: "forbidden" });

        await db.identityProviderInstance.update({
            where: { id: provider.id },
            data: { enabled: false, revision: { increment: 1 } },
        });
        await expect(verifyGitHubAppInstallationWithAdministratorProfile({
            actorAccountId,
            owner: { kind: "team", teamId: team.id },
            registrationId: created.registration.id,
            expectedRegistrationRevision: 2,
            expectedRegistrationSecurityRevision: created.registration.securityRevision,
            expectedInstallationRevision: 1,
            expectedNetworkPolicyFingerprint: network.fingerprint,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
            administrator: { githubUserId: 501n, githubUserLogin: "github-admin-1" },
        })).resolves.toMatchObject({ status: "verified", installation: { revision: 2 } });
        await expect(db.identityProviderInstance.findUnique({ where: { id: provider.id } }))
            .resolves.toMatchObject({ enabled: false });
    });

    it("creates one redacted Home-owned draft and keeps plaintext secrets out of storage", async () => {
        const actorAccountId = await createAccount("owner");
        const result = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 41n,
                githubClientId: "Iv1.client",
                githubAppSlug: "happier-acme",
                githubOwnerId: 51n,
                githubOwnerLogin: "acme",
                secrets: { v: 1, clientSecret: "client-secret", privateKey: "private-key" },
            },
        });

        expect(result).toMatchObject({
            status: "created",
            registration: {
                owner: { kind: "home" },
                githubHost: "https://github.com",
                githubAppId: 41n,
                revision: 1,
                securityRevision: 1,
                state: "draft",
                secretHealth: {
                    clientSecretConfigured: true,
                    privateKeyConfigured: true,
                    webhookSecretConfigured: false,
                },
            },
        });
        expect(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value))
            .not.toContain("client-secret");

        if (result.status !== "created") throw new Error("expected created registration");
        const stored = await db.gitHubAppRegistration.findUniqueOrThrow({ where: { id: result.registration.id } });
        expect(Buffer.from(stored.encryptedSecrets).toString("utf8")).not.toContain("client-secret");
        expect(Buffer.from(stored.encryptedSecrets).toString("utf8")).not.toContain("private-key");

        await expect(readGitHubAppRegistrationRuntime(result.registration.id)).resolves.toMatchObject({
            status: "resolved",
            runtime: {
                registration: { id: result.registration.id, githubAppId: 41n },
                secrets: { v: 1, clientSecret: "client-secret", privateKey: "private-key" },
            },
        });
    });

    it("uses the canonical Home capability and refuses an ordinary Home admin", async () => {
        const actorAccountId = await createAccount("admin");
        const authority = resolveHomeGovernanceAuthority({
            accountId: actorAccountId,
            homeRole: "admin",
            status: "active",
        });
        expect(authority.manageAuthentication).toBe(false);

        await expect(createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 42n,
                githubClientId: "Iv1.denied",
                secrets: { v: 1, privateKey: "private-key" },
            },
        })).resolves.toEqual({ status: "forbidden" });
        await expect(db.gitHubAppRegistration.count()).resolves.toBe(0);
    });

    it("advances the administrative revision on every edit and security revision only for security-effective edits", async () => {
        const actorAccountId = await createAccount("owner");
        const created = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 43n,
                githubClientId: "Iv1.revisions",
                secrets: { v: 1, clientSecret: "client-secret-v1", privateKey: "private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected created registration");

        const displayEdit = await updateHomeGitHubAppRegistration({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRevision: 1,
            patch: { githubAppSlug: "renamed-app" },
        });
        expect(displayEdit).toMatchObject({
            status: "updated",
            registration: { revision: 2, securityRevision: 1, githubAppSlug: "renamed-app" },
        });

        const rotation = await updateHomeGitHubAppRegistration({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRevision: 2,
            patch: { secrets: { clientSecret: "client-secret-v2" } },
        });
        expect(rotation).toMatchObject({
            status: "updated",
            registration: { revision: 3, securityRevision: 2 },
        });

        await expect(updateHomeGitHubAppRegistration({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRevision: 2,
            patch: { githubAppSlug: "stale-write" },
        })).resolves.toMatchObject({
            status: "revision_conflict",
            registration: { revision: 3, securityRevision: 2, githubAppSlug: "renamed-app" },
        });
        await expect(readGitHubAppRegistrationRuntime(created.registration.id)).resolves.toMatchObject({
            status: "resolved",
            runtime: { secrets: { clientSecret: "client-secret-v2", privateKey: "private-key" } },
        });
    });

    it("persists only authenticated exact App, installation, and organization evidence", async () => {
        const actorAccountId = await createAccount("owner");
        const created = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 44n,
                githubClientId: "Iv1.installation",
                secrets: { v: 1, clientSecret: "client-secret", privateKey: "private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected created registration");

        await expect(verifyHomeGitHubAppInstallation({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRegistrationRevision: 1,
            expectedInstallationRevision: 0,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
        })).resolves.toMatchObject({
            status: "verified",
            registration: { state: "verified", revision: 2 },
            installation: {
                githubInstallationId: 301n,
                githubOrganizationId: 401n,
                githubOrganizationLogin: "Acme",
                repositorySelection: "selected",
                revision: 1,
                state: "verified",
                verifiedPermissions: { members: "read" },
            },
        });

        await expect(listGitHubAppRegistrations({
            actorAccountId,
            owner: { kind: "home" },
        })).resolves.toMatchObject({
            status: "ready",
            installations: [{
                registrationId: created.registration.id,
                githubInstallationId: 301n,
                githubOrganizationId: 401n,
                revision: 1,
            }],
        });
        const provider = await db.identityProviderInstance.findFirstOrThrow({
            where: { githubAppInstallationId: (await db.gitHubAppInstallation.findFirstOrThrow()).id },
        });
        expect(provider).toMatchObject({ kind: "github_app_identity", enabled: false });
        await expect(setHomeManagedIdentityProviderEnabled({
            actorAccountId,
            id: provider.id,
            expectedRevision: provider.revision,
            expectedSecurityRevision: provider.securityRevision,
            enabled: true,
            env: { HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
        })).resolves.toMatchObject({ status: "applied", instance: { enabled: true } });
        await expect(listHomeManagedIdentityProviders({ actorAccountId }))
            .resolves.toMatchObject({
                status: "ready",
                instances: [{
                    status: "ready",
                    instance: {
                        id: provider.id,
                        kind: "github_app_identity",
                        enabled: true,
                        githubAppInstallationId: expect.any(String),
                    },
                }],
            });
        await expect(updateHomeManagedIdentityProvider({
            actorAccountId,
            id: provider.id,
            expectedRevision: provider.revision + 1,
            displayName: "Not an OIDC editor",
        })).resolves.toEqual({ status: "provider_unavailable" });
        await expect(replaceHomeManagedIdentityProviderSecret({
            actorAccountId,
            id: provider.id,
            expectedRevision: provider.revision + 1,
            clientSecret: "must-not-be-copied",
        })).resolves.toEqual({ status: "provider_unavailable" });
        await expect(validateHomeManagedIdentityProvider({
            actorAccountId,
            id: provider.id,
            expectedRevision: provider.revision + 1,
            expectedSecurityRevision: provider.securityRevision,
        })).resolves.toEqual({ status: "provider_unavailable" });

        githubMocks.appRequest.mockResolvedValueOnce({
            data: {
                id: 302,
                app_id: 44,
                account: { id: 401, login: "Acme", type: "Organization" },
                repository_selection: "all",
                permissions: { members: "read" },
                events: [],
                suspended_at: null,
            },
        });
        await expect(verifyHomeGitHubAppInstallation({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRegistrationRevision: 2,
            expectedInstallationRevision: 1,
            githubInstallationId: 302n,
            githubOrganizationId: 401n,
        })).resolves.toEqual({ status: "github_installation_mismatch" });
        await expect(db.gitHubAppInstallation.findFirstOrThrow()).resolves.toMatchObject({
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
            revision: 1,
        });

        githubMocks.appRequest.mockResolvedValueOnce({
            data: {
                id: 302,
                app_id: 44,
                account: { id: 999, login: "Imposter", type: "Organization" },
                repository_selection: "all",
                permissions: { members: "read" },
                events: [],
                suspended_at: null,
            },
        });
        await expect(verifyHomeGitHubAppInstallation({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRegistrationRevision: 2,
            expectedInstallationRevision: 0,
            githubInstallationId: 302n,
            githubOrganizationId: 401n,
        })).resolves.toEqual({ status: "github_organization_mismatch" });
        await expect(db.gitHubAppInstallation.count()).resolves.toBe(1);
    });

    it("rejects installation binding when the initiating Account is not the observed GitHub organization administrator", async () => {
        const actorAccountId = await createAccount("owner");
        const created = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 44n,
                githubClientId: "Iv1.admin-proof",
                secrets: { v: 1, privateKey: "private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected created registration");
        githubMocks.installationRequest.mockResolvedValueOnce({
            data: { state: "active", role: "admin", user: { id: 999 } },
        });

        await expect(verifyHomeGitHubAppInstallation({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRegistrationRevision: 1,
            expectedInstallationRevision: 0,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
        })).resolves.toEqual({ status: "github_administrator_mismatch" });
        await expect(db.gitHubAppInstallation.count()).resolves.toBe(0);
    });

    it("rejects installation binding when the returned App lacks the identity consumer permission", async () => {
        const actorAccountId = await createAccount("owner");
        const created = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 44n,
                githubClientId: "Iv1.permission-proof",
                secrets: { v: 1, clientSecret: "client-secret", privateKey: "private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected created registration");
        githubMocks.appRequest.mockImplementation(async (route: string) => ({
            data: route.startsWith("POST ")
                ? { token: "installation-token" }
                : {
                    id: 301,
                    app_id: 44,
                    account: { id: 401, login: "Acme", type: "Organization" },
                    repository_selection: "selected",
                    permissions: {},
                    events: [],
                    suspended_at: null,
                },
        }));

        await expect(verifyHomeGitHubAppInstallation({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRegistrationRevision: 1,
            expectedInstallationRevision: 0,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
        })).resolves.toEqual({ status: "github_permission_missing" });
        await expect(db.gitHubAppInstallation.count()).resolves.toBe(0);
        await expect(db.identityProviderInstance.count()).resolves.toBe(0);
    });

    it("persists a suspended GitHub installation in the canonical suspended state", async () => {
        const actorAccountId = await createAccount("owner");
        const created = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 44n,
                githubClientId: "Iv1.suspended",
                secrets: { v: 1, privateKey: "private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected created registration");
        githubMocks.appRequest.mockImplementation(async (route: string) => ({
            data: route.startsWith("POST ")
                ? { token: "installation-token" }
                : {
                    id: 301,
                    app_id: 44,
                    account: { id: 401, login: "Acme", type: "Organization" },
                    repository_selection: "selected",
                    permissions: { members: "read" },
                    events: [],
                    suspended_at: "2026-09-06T00:00:00.000Z",
                },
        }));

        await expect(verifyHomeGitHubAppInstallation({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRegistrationRevision: 1,
            expectedInstallationRevision: 0,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
        })).resolves.toMatchObject({
            status: "verified",
            installation: { state: "suspended", suspendedAt: expect.any(Date) },
        });
    });

    it("records who added, changed, verified and removed a Home GitHub App in Activity, never its secrets", async () => {
        const actorAccountId = await createAccount("owner");
        const created = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 44n,
                githubClientId: "Iv1.audit",
                githubAppSlug: "acme-happier",
                secrets: { v: 1, clientSecret: "audit-client-secret", privateKey: "audit-private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected created registration");
        const updated = await updateHomeGitHubAppRegistration({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRevision: 1,
            patch: { secrets: { clientSecret: "rotated-client-secret" } },
        });
        expect(updated.status).toBe("updated");
        const verified = await verifyHomeGitHubAppInstallation({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRegistrationRevision: 2,
            expectedInstallationRevision: 0,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
        });
        if (verified.status !== "verified") throw new Error("expected verified installation");
        // The identity provider the verification created must go first; removal refuses otherwise.
        await db.identityProviderInstance.deleteMany({ where: { githubAppInstallationId: verified.installation.id } });
        await expect(removeHomeGitHubAppInstallation({
            actorAccountId,
            installationId: verified.installation.id,
            expectedRevision: verified.installation.revision,
        })).resolves.toEqual({ status: "removed" });

        const listed = await inTx((tx) => listHomeAdministrationEventsInTx(tx, { targetId: created.registration.id }));
        if (listed.status !== "ok") throw new Error("expected audit page");
        expect(listed.result.items.map((event) => [event.action, event.summary, event.actor.accountId, event.target?.kind]))
            .toEqual([
                ["github_app.installation.remove", { name: "acme-happier", organization: "Acme" }, actorAccountId, "github_app"],
                ["github_app.installation.verify", { name: "acme-happier", organization: "Acme" }, actorAccountId, "github_app"],
                ["github_app.update", { name: "acme-happier", secretsReplaced: true }, actorAccountId, "github_app"],
                ["github_app.create", { name: "acme-happier" }, actorAccountId, "github_app"],
            ]);
        const stored = JSON.stringify(await db.homeAdministrationEvent.findMany({}));
        for (const secret of ["audit-client-secret", "audit-private-key", "rotated-client-secret"]) {
            expect(stored).not.toContain(secret);
        }
    });

    it("blocks installation removal while a directory source references it", async () => {
        const actorAccountId = await createAccount("owner");
        const created = await createHomeGitHubAppRegistration({
            actorAccountId,
            input: {
                githubHost: "https://github.com",
                githubAppId: 44n,
                githubClientId: "Iv1.remove",
                secrets: { v: 1, privateKey: "private-key" },
            },
        });
        if (created.status !== "created") throw new Error("expected created registration");
        const verified = await verifyHomeGitHubAppInstallation({
            actorAccountId,
            registrationId: created.registration.id,
            expectedRegistrationRevision: 1,
            expectedInstallationRevision: 0,
            githubInstallationId: 301n,
            githubOrganizationId: 401n,
        });
        if (verified.status !== "verified") throw new Error("expected verified installation");
        const team = await db.team.create({ data: { name: "Acme team" } });
        await db.teamDirectorySource.create({
            data: {
                teamId: team.id,
                kind: "github_organization",
                state: "initializing",
                displayName: "Acme",
                externalSourceKey: "github:test",
                bindingConfig: { v: 1, kind: "github_organization", githubOrganizationLogin: "Acme" },
                githubAppInstallationId: verified.installation.id,
            },
        });

        await expect(removeHomeGitHubAppInstallation({
            actorAccountId,
            installationId: verified.installation.id,
            expectedRevision: 1,
        })).resolves.toEqual({
            status: "blocked",
            blockers: { directorySources: 1, identityProviderInstances: 1 },
        });
        await expect(db.gitHubAppInstallation.count()).resolves.toBe(1);
    });
});
