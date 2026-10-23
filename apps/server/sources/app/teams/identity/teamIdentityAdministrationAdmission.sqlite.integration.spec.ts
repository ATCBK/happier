import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listHomeManagedIdentityProviders } from "@/app/home/governance/homeManagedIdentityProviders";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";
import { listExternalGroupBindingsForActor } from "../directory/externalGroupBindingAdministration";
import { preflightTeamIdentityConnectionRemovalForActor } from "./teamIdentityConnectionAdministration";

describe("Team identity administration admission", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-identity-admission-", initAuth: false,
            env: { HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1" },
        });
        await db.homeGovernancePolicy.create({ data: {
            id: "home", teamProviderPolicy: {
                v: 1, allowedTeamProviderKinds: ["oidc", "workos_sso"],
                teamJitAllowed: false, approvedGitHubEnterpriseOrigins: [],
            },
        } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: {} });
        const team = await db.team.create({ data: { name: `Admission ${crypto.randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "workos_sso", displayName: "SSO", config: { v: 1, kind: "workos_sso" },
        } });
        const connection = await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "workos_sso", organizationId: null, connectionId: null },
            settings: { v: 1, kind: "workos_sso" },
        } });
        return { owner, team, connection };
    }

    it("lists bindings with one acquisition of the admitted Team actor", async () => {
        const f = await fixture();
        const requests: string[] = [];
        const stop = observeSqliteRequests({ before: request => { requests.push(`${request.model}.${request.action}`); } });
        try {
            await expect(listExternalGroupBindingsForActor({
                v: 1, teamId: f.team.id, actorAccountId: f.owner.id,
                ownerKind: "identity_connection", teamIdentityConnectionId: f.connection.id,
            })).resolves.toEqual({ ok: true, value: { items: [], nextCursor: null } });
        } finally { stop(); }
        expect(requests.filter(request => request === "Team.findUnique")).toHaveLength(1);
    });

    it.each(["providers", "removal preview"] as const)("keeps %s free of mutation-audience reads", async (operation) => {
        const f = await fixture();
        // A Team roster cannot make a read-only page acquire every member's
        // Session/Machine publication audience.
        const accounts = Array.from({ length: 100 }, () => ({ id: crypto.randomUUID() }));
        await db.account.createMany({ data: accounts });
        await db.teamMembership.createMany({ data: accounts.map(account => ({ teamId: f.team.id, accountId: account.id, role: "member" as const })) });
        const audienceReads: string[] = [];
        const stop = observeSqliteRequests({ before: request => {
            if (request.model === "Machine" || request.model === "Session"
                || (request.model === "TeamMembership" && request.action === "findMany")) {
                audienceReads.push(`${request.model}.${request.action}`);
            }
        } });
        try {
            const result = operation === "providers"
                ? await listHomeManagedIdentityProviders({ actorAccountId: f.owner.id, owner: { kind: "team", teamId: f.team.id } })
                : await preflightTeamIdentityConnectionRemovalForActor({
                    v: 1, teamId: f.team.id, actorAccountId: f.owner.id, connectionId: f.connection.id,
                    expectedRevision: 1, env: process.env,
                });
            expect("status" in result ? result.status === "ready" : result.ok).toBe(true);
        } finally { stop(); }
        expect(audienceReads).toEqual([]);
    });

    it("preserves member, suspended admin, removed admin, other-Team admin and wrong-credential refusals", async () => {
        const f = await fixture();
        const member = await db.account.create({ data: {} });
        const suspended = await db.account.create({ data: {} });
        const removed = await db.account.create({ data: {} });
        const otherAdmin = await db.account.create({ data: { homeRole: "owner" } });
        const otherTeam = await db.team.create({ data: { name: "Other administration" } });
        await db.teamMembership.createMany({ data: [
            { teamId: f.team.id, accountId: member.id, role: "member" },
            { teamId: f.team.id, accountId: suspended.id, role: "admin", status: "suspended" },
            { teamId: f.team.id, accountId: removed.id, role: "admin" },
            { teamId: otherTeam.id, accountId: otherAdmin.id, role: "admin" },
        ] });
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team.id, accountId: removed.id } } });
        for (const [actor, error] of [
            [member, "team_forbidden"], [suspended, "team_not_found"],
            [removed, "team_not_found"], [otherAdmin, "team_not_found"],
        ] as const) {
            await expect(listHomeManagedIdentityProviders({
                actorAccountId: actor.id, owner: { kind: "team", teamId: f.team.id },
            })).resolves.toEqual({ status: "forbidden" });
            await expect(preflightTeamIdentityConnectionRemovalForActor({
                v: 1, teamId: f.team.id, actorAccountId: actor.id, connectionId: f.connection.id,
                expectedRevision: 1, env: process.env,
            })).resolves.toEqual({ ok: false, error });
            await expect(listExternalGroupBindingsForActor({
                v: 1, teamId: f.team.id, actorAccountId: actor.id,
                ownerKind: "identity_connection", teamIdentityConnectionId: f.connection.id,
            })).resolves.toEqual({ ok: false, error });
        }
        await db.team.update({ where: { id: f.team.id }, data: { authenticationPolicy: {
            v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "email_password" }],
        } } });
        const wrongCredential = {
            authenticationAuthority: "present_user",
            authenticationEvidence: [{ kind: "home_method", methodId: "key_challenge" }],
        } as const;
        await expect(listHomeManagedIdentityProviders({
            actorAccountId: f.owner.id, owner: { kind: "team", teamId: f.team.id }, ...wrongCredential,
        })).resolves.toEqual({ status: "team_authentication_required" });
        await expect(preflightTeamIdentityConnectionRemovalForActor({
            v: 1, teamId: f.team.id, actorAccountId: f.owner.id, connectionId: f.connection.id,
            expectedRevision: 1, env: process.env, ...wrongCredential,
        })).resolves.toEqual({ ok: false, error: "team_authentication_required" });
        await expect(listExternalGroupBindingsForActor({
            v: 1, teamId: f.team.id, actorAccountId: f.owner.id, ...wrongCredential,
            ownerKind: "identity_connection", teamIdentityConnectionId: f.connection.id,
        })).resolves.toEqual({ ok: false, error: "team_authentication_required" });
    });

    it("keeps Home removal preview owner-only even though Home admins may view connections", async () => {
        const admin = await db.account.create({ data: { homeRole: "admin" } });
        await expect(preflightTeamIdentityConnectionRemovalForActor({
            v: 1, teamId: null, actorAccountId: admin.id, connectionId: "missing",
            expectedRevision: 1, env: process.env,
        })).resolves.toEqual({ ok: false, error: "home_forbidden" });
    });
});
