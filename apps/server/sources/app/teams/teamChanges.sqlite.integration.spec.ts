import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import type { HomeRole } from "@/storage/enums.generated";

import { archiveTeamInTx, createTeamInTx, restoreTeamInTx, updateTeamInTx } from "./lifecycle";
import { TEAM_CHANGE_ENTITY_ID, publishTeamChangedInTx, publishGitHubAppRegistrationTeamsChangedInTx } from "./teamChanges";

describe("Team invalidation audience (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-team-changes-", initAuth: false });
        await db.homeGovernancePolicy.upsert({
            where: { id: HOME_GOVERNANCE_POLICY_ID },
            create: { id: HOME_GOVERNANCE_POLICY_ID, revision: 1, teamCreationPolicy: "self_service" },
            update: { teamCreationPolicy: "self_service" },
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function account(homeRole: HomeRole = "member", status: "active" | "suspended" | "disabled" = "active") {
        return db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain", homeRole, status },
        });
    }

    /** The change a client actually observes: one coalesced `teams` row per Account. */
    async function teamChangeCursor(accountId: string): Promise<number | null> {
        const row = await db.accountChange.findFirst({
            where: { accountId, kind: "account", entityId: TEAM_CHANGE_ENTITY_ID },
            select: { cursor: true },
        });
        return row?.cursor ?? null;
    }

    async function seq(accountId: string): Promise<number> {
        return (await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } })).seq;
    }

    async function createTeam(actorAccountId: string, name: string) {
        const created = await inTx(tx => createTeamInTx(tx, {
            actorAccountId, name, requestKey: crypto.randomUUID(),
        }));
        if (!created.ok) throw new Error(`fixture Team creation failed: ${created.error}`);
        return created.team;
    }

    it("does not publish Team invalidation for a Home-only GitHub identity binding", async () => {
        const owner = await account("owner");
        const registration = await db.gitHubAppRegistration.create({ data: {
            githubHost: "https://github.com", githubAppId: 901n, githubClientId: "home-only",
            encryptedSecrets: Uint8Array.from([1]), config: { v: 1, secretHealth: {
                clientSecretConfigured: false, privateKeyConfigured: true, webhookSecretConfigured: false,
            } },
        } });
        const installation = await db.gitHubAppInstallation.create({ data: {
            registrationId: registration.id, githubInstallationId: 902n,
            githubOrganizationId: 903n, githubOrganizationLogin: "HomeOnly", repositorySelection: "all",
        } });
        const provider = await db.identityProviderInstance.create({ data: {
            kind: "github_app_identity", displayName: "Home only", config: { v: 1, kind: "github_app_identity" },
            githubAppInstallationId: installation.id,
        } });
        await db.teamIdentityConnection.create({ data: {
            teamId: null, providerInstanceId: provider.id,
            externalReference: { v: 1, kind: "github_app_identity", installationId: installation.id },
            settings: { v: 1, kind: "github_app_identity", organizationLogin: "HomeOnly" },
        } });
        const before = await seq(owner.id);
        expect(await inTx(tx => publishGitHubAppRegistrationTeamsChangedInTx(tx, {
            registrationId: registration.id,
        }))).toBe(0);
        expect(await seq(owner.id)).toBe(before);
    });

    it("wakes the active Home administrators whose Home-level Team directory changed", async () => {
        const founder = await account();
        const homeOwner = await account("owner");
        const homeAdmin = await account("admin");

        const team = await createTeam(founder.id, `Directory ${crypto.randomUUID()}`);

        // The administered directory is a Home-level projection: creating a Team
        // changes it for every administrator, none of whom is a member. An already
        // mounted admin directory would otherwise stay stale until remounted.
        expect(await teamChangeCursor(homeOwner.id)).not.toBeNull();
        expect(await teamChangeCursor(homeAdmin.id)).not.toBeNull();
        expect(await teamChangeCursor(founder.id)).not.toBeNull();

        const ownerBefore = await teamChangeCursor(homeOwner.id);
        await inTx(tx => updateTeamInTx(tx, {
            actorAccountId: founder.id, teamId: team.id, name: "Renamed for the directory",
        }));
        const ownerAfterRename = await teamChangeCursor(homeOwner.id);
        expect(ownerAfterRename).toBeGreaterThan(ownerBefore ?? 0);

        await inTx(tx => archiveTeamInTx(tx, { actorAccountId: founder.id, teamId: team.id }));
        expect(await teamChangeCursor(homeOwner.id)).toBeGreaterThan(ownerAfterRename ?? 0);

        const beforeRestore = await teamChangeCursor(homeAdmin.id);
        await inTx(tx => restoreTeamInTx(tx, { actorAccountId: founder.id, teamId: team.id }));
        expect(await teamChangeCursor(homeAdmin.id)).toBeGreaterThan(beforeRestore ?? 0);
    });

    it("wakes an administrator who is also a member exactly once", async () => {
        const adminFounder = await account("admin");
        const team = await createTeam(adminFounder.id, `Both roles ${crypto.randomUUID()}`);

        const before = await seq(adminFounder.id);
        await inTx(tx => updateTeamInTx(tx, {
            actorAccountId: adminFounder.id, teamId: team.id, description: "One wake, not three.",
        }));

        // `markAccountChanged` allocates a cursor by incrementing `Account.seq`
        // once per call. Membership, the administrator set, and the actor overlap
        // here, so a union that did not dedupe would advance the sequence more
        // than once for one mutation.
        expect(await seq(adminFounder.id)).toBe(before + 1);
    });

    it("never wakes an inactive administrator or an unrelated ordinary member", async () => {
        const founder = await account();
        const retiredAdmin = await account("admin", "disabled");
        const suspendedAdmin = await account("admin", "suspended");
        const stranger = await account();

        await createTeam(founder.id, `Quiet ${crypto.randomUUID()}`);

        // An inactive Account holds no authority, so its directory projection did
        // not change; an ordinary member of no Team has no Home-level directory.
        expect(await teamChangeCursor(retiredAdmin.id)).toBeNull();
        expect(await teamChangeCursor(suspendedAdmin.id)).toBeNull();
        expect(await teamChangeCursor(stranger.id)).toBeNull();
    });

    it("honors explicit exclusions across members, administrators, and additional Accounts", async () => {
        const founder = await account();
        const excludedAdmin = await account("admin");
        const includedAdmin = await account("admin");
        const extra = await account();
        const team = await createTeam(founder.id, `Excluded ${crypto.randomUUID()}`);

        const excludedAdminBefore = await seq(excludedAdmin.id);
        const founderBefore = await seq(founder.id);
        const includedAdminBefore = await seq(includedAdmin.id);

        const published = await inTx(tx => publishTeamChangedInTx(tx, {
            teamId: team.id,
            additionalAccountIds: [extra.id],
            // The caller already marked these in this transaction; marking them
            // again would allocate a second cursor for one logical change.
            excludeAccountIds: [excludedAdmin.id, founder.id],
        }));

        // Exclusion is per Account, not a blanket skip of a source: the excluded
        // administrator and the excluded member are untouched while a different
        // administrator is still woken.
        expect(await seq(excludedAdmin.id)).toBe(excludedAdminBefore);
        expect(await seq(founder.id)).toBe(founderBefore);
        expect(await seq(includedAdmin.id)).toBe(includedAdminBefore + 1);
        expect(await teamChangeCursor(extra.id)).not.toBeNull();
        // The count is the audience actually marked. It is not asserted exactly,
        // because this harness retains the administrators earlier tests created —
        // they are legitimately part of every later audience.
        expect(published).toBeGreaterThanOrEqual(2);
    });
});
