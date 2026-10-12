import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { readTeamCredentialActivityInTx } from "./resourceActivity";

const TEST_AUTHENTICATION = { authenticationAuthority: "present_user", authenticationEvidence: [] } as const;

describe("Team credential activity reads", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "team-resource-activity-" }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("uses the live resource Team even before the first activity event exists", async () => {
        const actor = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Live activity team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "admin" } });
        await db.teamCredentialResource.create({ data: {
            id: "live-resource-without-history",
            teamId: team.id,
            custodianAccountId: actor.id,
            displayName: "Live resource",
            disclosureCeiling: "broker_only",
            sessionUsePolicy: "personal_allowed",
            sourceBindingJson: JSON.stringify({
                v: 1,
                kind: "provider_connection",
                providerId: "example",
                connectionId: "current",
                connectionRevision: "1",
            }),
        } });

        await expect(inTx(tx => readTeamCredentialActivityInTx(tx, {
            resourceId: "live-resource-without-history",
            actorAccountId: actor.id,
            authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: true, page: { items: [], nextCursor: null } });
    });

    it("authorizes managers after resource deletion and paginates newest first", async () => {
        const actor = await db.account.create({ data: { encryptionMode: "plain", name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace" } });
        const team = await db.team.create({ data: { name: "Activity team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: "admin" } });
        const resourceId = "deleted-resource";
        await db.teamCredentialActivityEvent.createMany({ data: [
            { teamId: team.id, resourceId, kind: "resource_created", actorAccountId: actor.id, subjectDisplayName: "Shared" },
            { teamId: team.id, resourceId, kind: "resource_deleted", actorAccountId: actor.id, subjectDisplayName: "Shared" },
        ] });
        const first = await inTx(tx => readTeamCredentialActivityInTx(tx, { resourceId, actorAccountId: actor.id, limit: 1, authentication: TEST_AUTHENTICATION }));
        expect(first).toMatchObject({ ok: true, page: { items: [{ kind: "resource_deleted", actorDisplayName: "Ada Lovelace" }] } });
        if (!first.ok) throw new Error("expected first page");
        expect(first.page.nextCursor).toEqual(expect.any(String));
        const second = await inTx(tx => readTeamCredentialActivityInTx(tx, {
            resourceId, actorAccountId: actor.id, limit: 1, cursor: first.page.nextCursor ?? undefined, authentication: TEST_AUTHENTICATION,
        }));
        expect(second).toMatchObject({ ok: true, page: { items: [{ kind: "resource_created" }], nextCursor: null } });

        const wrongResource = await inTx(tx => readTeamCredentialActivityInTx(tx, {
            resourceId: "other-resource", actorAccountId: actor.id, limit: 1,
            cursor: first.page.nextCursor ?? undefined, authentication: TEST_AUTHENTICATION,
        }));
        expect(wrongResource).toEqual({ ok: false, error: "resource_not_found" });

        const legacyLooseCursor = Buffer.from(JSON.stringify({
            v: 1,
            resourceId,
            createdAt: new Date().toISOString(),
            id: "event-id",
            extra: true,
        }), "utf8").toString("base64url");
        await expect(inTx(tx => readTeamCredentialActivityInTx(tx, {
            resourceId, actorAccountId: actor.id, cursor: legacyLooseCursor, authentication: TEST_AUTHENTICATION,
        }))).resolves.toEqual({ ok: false, error: "invalid_resource_input" });
    });

    it("does not expose history to a non-manager", async () => {
        const admin = await db.account.create({ data: { encryptionMode: "plain" } });
        const member = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Private activity team" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: admin.id, role: "admin" },
            { teamId: team.id, accountId: member.id, role: "member" },
        ] });
        await db.teamCredentialActivityEvent.create({ data: {
            teamId: team.id, resourceId: "private-resource", kind: "resource_created",
            actorAccountId: admin.id, subjectDisplayName: "Private",
        } });
        await expect(inTx(tx => readTeamCredentialActivityInTx(tx, { resourceId: "private-resource", actorAccountId: member.id, authentication: TEST_AUTHENTICATION })))
            .resolves.toEqual({ ok: false, error: "resource_forbidden" });
    });
});
