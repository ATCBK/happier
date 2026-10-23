import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasCurrentTeamCredentialAudienceMatchInTx, resolveTeamCredentialEntitlementInTx } from "./resourceAccess";
import { resolveTeamGroupMembershipsForAccountInTx } from "../groups/effectiveGroupMembership";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Team credential audience query cost (PostgreSQL)", () => {
    const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    let selects = 0;
    client.$on("query", event => { if (/^SELECT\b/i.test(event.query)) selects++; });
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run only through the disposable PostgreSQL DB-contract harness");
        }
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); });

    it("uses a constant SQL budget for 120 Group grants and preserves revocation", async () => {
        const [custodian, recipient] = await Promise.all([0, 1].map(() => client.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } })));
        const team = await client.team.create({ data: { name: `Credential cost ${randomUUID()}` } });
        try {
            await client.teamMembership.create({ data: { teamId: team.id, accountId: custodian!.id, role: "owner" } });
            const membership = await client.teamMembership.create({ data: { teamId: team.id, accountId: recipient!.id, role: "guest" } });
            const groups = Array.from({ length: 120 }, (_, index) => ({ id: randomUUID(), teamId: team.id, name: `Group ${index}`, nameKey: `group-${index}` }));
            await client.teamGroup.createMany({ data: groups });
            const resource = await client.teamCredentialResource.create({ data: {
                teamId: team.id, custodianAccountId: custodian!.id, displayName: "Cost fixture",
                disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed", sourceBindingJson: "{}",
                groupGrants: { create: { teamGroupId: groups[0]!.id, deliveryMode: "brokered" } },
            } });
            const read = async () => {
                const input = { resourceId: resource.id, accountId: recipient!.id };
                selects = 0;
                const entitlement = await client.$transaction(tx => resolveTeamCredentialEntitlementInTx(tx, input), { isolationLevel: "RepeatableRead" });
                const entitlementSelects = selects;
                selects = 0;
                const match = await client.$transaction(tx => hasCurrentTeamCredentialAudienceMatchInTx(tx, input), { isolationLevel: "RepeatableRead" });
                return { entitlement, match, entitlementSelects, matchSelects: selects };
            };
            const single = await read();
            await client.teamCredentialGroupGrant.createMany({ data: groups.slice(1).map(group => ({ resourceId: resource.id, teamGroupId: group.id, deliveryMode: "brokered" })) });
            const page = await read();
            expect(page.entitlement).toEqual({ ok: false, reason: "access_removed" });
            expect(page.match).toBe(false);
            expect(page.entitlementSelects).toBe(single.entitlementSelects);
            expect(page.matchSelects).toBe(single.matchSelects);
            await client.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: groups[119]!.id, teamMembershipId: membership.id, nativeContribution: true } });
            expect(await read()).toMatchObject({ entitlement: { ok: true, mayBroker: true }, match: true });
            await client.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
            expect(await read()).toMatchObject({ entitlement: { ok: false, reason: "access_removed" }, match: false });
            await client.teamMembership.update({ where: { id: membership.id }, data: { status: "active" } });
            await client.teamGroup.update({ where: { id: groups[119]!.id }, data: { archivedAt: new Date() } });
            expect(await read()).toMatchObject({ entitlement: { ok: false, reason: "access_removed" }, match: false });
            await client.teamGroup.update({ where: { id: groups[119]!.id }, data: { archivedAt: null } });
            const unrelatedGroup = await client.teamGroup.create({ data: { teamId: team.id, name: "Not granted", nameKey: "not-granted" } });
            await client.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: unrelatedGroup.id, teamMembershipId: membership.id, nativeContribution: true } });
            selects = 0;
            const selected = await client.$transaction(tx => resolveTeamGroupMembershipsForAccountInTx(tx, {
                teamId: team.id, accountId: recipient!.id, credentialResourceId: resource.id,
            }), { isolationLevel: "RepeatableRead" });
            expect(selected).toHaveLength(1);
            expect(selected[0]).toMatchObject({ teamGroupId: groups[119]!.id, teamMembershipId: membership.id, effective: true });
        } finally {
            await client.team.delete({ where: { id: team.id } });
            await client.account.deleteMany({ where: { id: { in: [custodian!.id, recipient!.id] } } });
        }
    });
});
