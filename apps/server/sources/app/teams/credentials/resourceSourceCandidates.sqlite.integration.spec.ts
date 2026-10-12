import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1,
    ConnectedServiceAuthGroupPolicyV1Schema,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createLegacyCredentialFixtureIdentity,
    createLegacyGroupFixtureIdentity,
    createLegacyGroupMemberFixtureIdentity,
} from "@/app/api/routes/connect/testkit/qualifiedConnectedAccountFixtureIdentity";

import { listTeamCredentialSourceCandidatesInTx } from "./resourceSourceCandidates";

const SERVICE_ID = "openai-codex" as const;
const TEST_AUTHENTICATION = {
    authenticationAuthority: "present_user",
    authenticationEvidence: [],
} as const;

async function createPool(params: Readonly<{
    accountId: string;
    groupId: string;
    displayName: string | null;
    memberProfileIds: readonly Readonly<{
        profileId: string;
        enabled: boolean;
        directExportSupported?: boolean;
    }>[];
}>) {
    const group = await db.connectedServiceAuthGroup.create({
        data: {
            accountId: params.accountId,
            vendor: SERVICE_ID,
            groupId: params.groupId,
            ...createLegacyGroupFixtureIdentity({ serviceId: SERVICE_ID, groupId: params.groupId }),
            displayName: params.displayName,
            policyJson: JSON.stringify(ConnectedServiceAuthGroupPolicyV1Schema.parse({})),
        },
    });
    for (const member of params.memberProfileIds) {
        const credential = await db.serviceAccountToken.create({
            data: {
                accountId: params.accountId,
                vendor: SERVICE_ID,
                profileId: member.profileId,
                // The identity helper owns the authentication mode too; naming
                // one here would let a fixture claim a mode the service does
                // not have.
                ...createLegacyCredentialFixtureIdentity({ serviceId: SERVICE_ID, profileId: member.profileId }),
                token: Buffer.from("encrypted"),
                metadata: member.directExportSupported === undefined
                    ? undefined
                    : {
                        v: 4,
                        storage: "stored_envelope_v1",
                        credentialRevision: `csr_source_candidate_revision_${member.profileId}`,
                        contributionContractVersion: "artifact-test-1",
                        ...(member.directExportSupported
                            ? { directExportContract: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 }
                            : {}),
                        values: { scopes: [] },
                    },
            },
        });
        await db.connectedServiceAuthGroupMember.create({
            data: {
                groupDbId: group.id,
                accountId: params.accountId,
                vendor: SERVICE_ID,
                groupId: params.groupId,
                profileId: member.profileId,
                enabled: member.enabled,
                ...createLegacyGroupMemberFixtureIdentity({
                    serviceId: SERVICE_ID,
                    profileId: member.profileId,
                    groupId: params.groupId,
                    credentialId: credential.id,
                }),
            },
        });
    }
    return group;
}

describe("Team credential source candidates", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "team-credential-sources-" });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("pins each offerable Pool to its persisted lifetime and names the resource already using it", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain", name: "Ada" } });
        const team = await db.team.create({ data: { name: "Sources team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "admin" } });

        const offered = await createPool({
            accountId: owner.id,
            groupId: "already-shared",
            displayName: "Shared pool",
            memberProfileIds: [{ profileId: "a", enabled: true, directExportSupported: true }],
        });
        const free = await createPool({
            accountId: owner.id,
            groupId: "free-pool",
            displayName: null,
            // A member the owner switched off is capacity they withdrew, so it
            // must not be counted as one the Team could select from.
            memberProfileIds: [
                { profileId: "b", enabled: true, directExportSupported: true },
                { profileId: "c", enabled: true, directExportSupported: false },
                { profileId: "d", enabled: false },
            ],
        });

        const resource = await db.teamCredentialResource.create({
            data: {
                id: "resource-already-shared",
                teamId: team.id,
                custodianAccountId: owner.id,
                displayName: "Shared",
                disclosureCeiling: "brokered_only",
                sessionUsePolicy: "personal_allowed",
                sourceBindingJson: JSON.stringify({
                    v: 1,
                    kind: "connected_pool",
                    target: {
                        kind: "group",
                        service: { pluginId: offered.servicePluginId, localId: offered.serviceLocalId },
                        groupId: offered.groupId,
                    },
                    poolIncarnation: offered.id,
                }),
            },
        });

        const result = await inTx(tx => listTeamCredentialSourceCandidatesInTx(tx, {
            actorAccountId: owner.id,
            teamId: team.id,
            authentication: TEST_AUTHENTICATION,
        }));
        if (!result.ok) throw new Error(`expected candidates, got ${result.error}`);

        const byGroupId = new Map(result.candidates.map((candidate) => [
            candidate.source.kind === "connected_pool" ? candidate.source.target.groupId : "",
            candidate,
        ]));

        // The pin is the persisted incarnation, not the logical group id: it is
        // what makes deleting and recreating a Pool a different source rather
        // than a silent retarget of the Team's resource.
        expect(byGroupId.get("free-pool")).toMatchObject({
            source: { kind: "connected_pool", poolIncarnation: free.id },
            label: "free-pool",
            memberCount: 2,
            directExportSupport: "mixed",
            offeredByResourceId: null,
        });
        expect(byGroupId.get("already-shared")).toMatchObject({
            label: "Shared pool",
            memberCount: 1,
            directExportSupport: "supported",
            offeredByResourceId: resource.id,
        });
        // Provider connections are composed from the custodian client's
        // canonical local Provider registry because Home cannot read encrypted
        // Account Settings. Publishing support here lets that client-owned
        // candidate join this answer without pretending Home enumerated it.
        expect(result.supportedKinds).toEqual(["connected_account", "connected_pool", "provider_connection"]);
    });

    it("offers a Connected Account with its canonical presentation and immutable credential lifetime", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain", name: "Ada" } });
        const team = await db.team.create({ data: { name: "Connected source team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "admin" } });
        const identity = createLegacyCredentialFixtureIdentity({ serviceId: SERVICE_ID, profileId: "primary" });
        const credential = await db.serviceAccountToken.create({
            data: {
                accountId: owner.id,
                vendor: SERVICE_ID,
                profileId: "primary",
                ...identity,
                token: Buffer.from("encrypted"),
                metadata: {
                    v: 4,
                    storage: "stored_envelope_v1",
                    credentialRevision: "csr_connected_source_candidate",
                    directExportContract: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1,
                    contributionContractVersion: "artifact-test-1",
                    values: {
                        displayName: "Work account",
                        scopes: [],
                    },
                    health: {
                        v: 1,
                        status: "connected",
                        reconnectRequired: false,
                    },
                },
            },
        });

        const result = await inTx(tx => listTeamCredentialSourceCandidatesInTx(tx, {
            actorAccountId: owner.id,
            teamId: team.id,
            authentication: TEST_AUTHENTICATION,
        }));
        if (!result.ok) throw new Error(`expected candidates, got ${result.error}`);

        expect(result.candidates).toContainEqual(expect.objectContaining({
            source: {
                v: 1,
                kind: "connected_account",
                target: {
                    kind: "account",
                        account: {
                            service: {
                                pluginId: identity.servicePluginId,
                                localId: identity.serviceLocalId,
                        },
                        accountId: "primary",
                    },
                },
                credentialIncarnation: credential.id,
            },
            label: "Work account",
            memberCount: null,
            directExportSupport: "supported",
            offeredByResourceId: null,
        }));
    });

    it("refuses a viewer this Team does not let offer their own credential", async () => {
        const guest = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Guarded team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: guest.id, role: "guest" } });
        await createPool({
            accountId: guest.id,
            groupId: "guest-pool",
            displayName: "Guest pool",
            memberProfileIds: [{ profileId: "g", enabled: true }],
        });

        // Owning a source is not permission to offer it: the Team's own decision
        // is, and a refusal must not leak the sources it would have listed.
        await expect(inTx(tx => listTeamCredentialSourceCandidatesInTx(tx, {
            actorAccountId: guest.id,
            teamId: team.id,
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, error: "forbidden" });
    });

    it("does not offer another Account's Pools", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const other = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Two owners team" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "admin" },
            { teamId: team.id, accountId: other.id, role: "admin" },
        ] });
        await createPool({
            accountId: other.id,
            groupId: "other-pool",
            displayName: "Not yours",
            memberProfileIds: [{ profileId: "x", enabled: true }],
        });

        const result = await inTx(tx => listTeamCredentialSourceCandidatesInTx(tx, {
            actorAccountId: owner.id,
            teamId: team.id,
            authentication: TEST_AUTHENTICATION,
        }));

        // Being a Team manager administers other people's resources; it never
        // makes their credentials yours to offer.
        expect(result).toMatchObject({ ok: true, candidates: [] });
    });
});
