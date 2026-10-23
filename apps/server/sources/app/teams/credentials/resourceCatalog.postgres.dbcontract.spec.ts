import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as catalog from "./resourceRead";

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Account credential discovery (PostgreSQL)", () => {
    const client = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
    let selects = 0;
    let maxBindings = 0;
    let projectedMembershipRows = 0;
    const observedClient = client.$extends({ query: { teamMembership: {
        async findMany({ args, query }) {
            const rows = await query(args);
            if (args.select?.groupMemberships) projectedMembershipRows += rows.length;
            return rows;
        },
    } } });
    client.$on("query", event => {
        if (/^SELECT\b/i.test(event.query)) selects++;
        const bindings = (JSON.parse(event.params) as unknown[]).length;
        maxBindings = Math.max(maxBindings, bindings);
    });
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run only through the disposable PostgreSQL DB-contract harness");
        }
        await client.$connect();
    });
    afterAll(async () => { await client.$disconnect(); });

    it("keeps catalog SQL independent of Team count, chunks inventory binds, and preserves current refusals", async () => {
        const actor = await client.account.create({ data: { encryptionMode: "plain" } });
        const custodian = await client.account.create({ data: { encryptionMode: "plain" } });
        const otherCustodians = await Promise.all(Array.from({ length: 5 }, () => client.account.create({
            data: { encryptionMode: "plain" },
        })));
        const custodians = [custodian, ...otherCustodians];
        const teamIds = Array.from({ length: 1001 }, () => randomUUID());
        const authentication = { authenticationAuthority: "present_user" as const };
        try {
            await client.team.createMany({ data: teamIds.map((id, index) => ({ id, name: `Catalog ${index}` })) });
            // Seed in portable chunks too: test setup must not hide a production bind failure.
            for (let index = 0; index < teamIds.length; index += 100) {
                await client.teamMembership.createMany({ data: teamIds.slice(index, index + 100).flatMap(teamId => [
                    { teamId, accountId: actor.id, role: "member" },
                    { teamId, accountId: custodian.id, role: "owner" },
                ]) });
            }
            await client.teamMembership.createMany({ data: teamIds.slice(0, 6).flatMap(teamId => otherCustodians.map(account => ({
                teamId, accountId: account.id, role: "member",
            }))) });
            const resources = await Promise.all(teamIds.slice(0, 6).map((teamId, index) => client.teamCredentialResource.create({ data: {
                teamId, custodianAccountId: custodians[index]!.id, displayName: `Resource ${index}`,
                sourceBindingJson: "{}", disclosureCeiling: "brokered_only", sessionUsePolicy: "personal_allowed",
                allMembersDeliveryMode: "brokered",
            } })));
            const read = async (ids: string[], cursor?: string) => {
                selects = 0;
                maxBindings = 0;
                projectedMembershipRows = 0;
                const result = await observedClient.$transaction(tx => catalog.readTeamCredentialDiscoveryInTx(tx, {
                    teamIds: ids, actorAccountId: actor.id, authentication, limit: 100, ...(cursor ? { cursor } : {}),
                }), { isolationLevel: "RepeatableRead" });
                return { result, selects, maxBindings, projectedMembershipRows };
            };
            const single = await read([teamIds[0]!]);
            const six = await read(teamIds.slice(0, 6));
            expect(six.result.ok).toBe(true);
            if (!six.result.ok) throw new Error("Discovery must succeed");
            expect(six.result.page.resources.map(row => row.id).sort()).toEqual(resources.map(row => row.id).sort());
            expect(six.selects).toBe(single.selects);
            expect(six.projectedMembershipRows).toBe(12);
            const inventory = await read(teamIds);
            expect(inventory.result).toEqual(six.result);
            expect(inventory.maxBindings).toBeLessThanOrEqual(999);
            expect(inventory.selects).toBeLessThan(six.selects * 3);
            expect(inventory.projectedMembershipRows).toBe(12);
            selects = 0;
            for (const teamId of teamIds.slice(0, 6)) {
                await client.$transaction(tx => catalog.readTeamCredentialCatalogInTx(tx, {
                    teamId, actorAccountId: actor.id, authentication,
                }));
            }

            const old = await client.$transaction(tx => catalog.readTeamCredentialCatalogInTx(tx, {
                teamId: teamIds[0]!, actorAccountId: actor.id, authentication,
            }));
            expect(single.result.ok && single.result.page.resources).toEqual(old.ok && old.page.resources);
            await client.teamMembership.update({ where: { teamId_accountId: { teamId: teamIds[0]!, accountId: actor.id } },
                data: { status: "suspended" } });
            await client.teamMembership.delete({ where: { teamId_accountId: { teamId: teamIds[1]!, accountId: actor.id } } });
            await client.teamCredentialResource.update({ where: { id: resources[2]!.id }, data: { allMembersDeliveryMode: null } });
            const missing = randomUUID();
            const refused = await read([...teamIds.slice(0, 6), missing]);
            expect(refused.result.ok).toBe(true);
            if (!refused.result.ok) throw new Error("Discovery must retain admitted siblings");
            expect(refused.result.page.failures).toEqual([
                { teamId: teamIds[0], error: "not_found_or_not_visible" },
                { teamId: teamIds[1], error: "not_found_or_not_visible" },
                { teamId: missing, error: "not_found_or_not_visible" },
            ]);
            expect(refused.result.page.resources.map(row => row.id).sort()).toEqual(resources.slice(3).map(row => row.id).sort());
            expect((await read([])).result).toMatchObject({ ok: true, page: { resources: [], nextCursor: null, failures: [] } });
            const page = await client.$transaction(tx => catalog.readTeamCredentialDiscoveryInTx(tx, {
                teamIds: teamIds.slice(3, 6), actorAccountId: actor.id, authentication, limit: 1,
            }));
            expect(page.ok && page.page.nextCursor).toBeTypeOf("string");
            if (!page.ok || !page.page.nextCursor) throw new Error("Discovery must page");
            const next = await read(teamIds.slice(3, 6).reverse(), page.page.nextCursor);
            expect(next.result.ok && next.result.page.resources.map(row => row.id)).toEqual(resources.slice(4).map(row => row.id));
            expect((await read([teamIds[4]!], page.page.nextCursor)).result).toEqual({ ok: false, error: "invalid_resource_input" });
            await client.team.update({ where: { id: teamIds[3]! }, data: { authenticationPolicy: {
                v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "email_password" }],
            } } });
            const restrictedOld = await client.$transaction(tx => catalog.readTeamCredentialCatalogInTx(tx, {
                teamId: teamIds[3]!, actorAccountId: actor.id, authentication,
            }));
            expect(restrictedOld.ok).toBe(false);
            const restricted = await read(teamIds.slice(3, 6));
            expect(restricted.result.ok && restricted.result.page.failures).toEqual(restrictedOld.ok ? [] : [
                { teamId: teamIds[3], error: restrictedOld.error },
            ]);
            await client.account.update({ where: { id: actor.id }, data: { status: "disabled" } });
            expect((await read([teamIds[4]!])).result).toMatchObject({ ok: true,
                page: { resources: [], failures: [{ teamId: teamIds[4], error: "not_found_or_not_visible" }] } });
        } finally {
            for (let index = 0; index < teamIds.length; index += 100) {
                await client.team.deleteMany({ where: { id: { in: teamIds.slice(index, index + 100) } } });
            }
            await client.account.deleteMany({ where: { id: { in: [actor.id, ...custodians.map(account => account.id)] } } });
        }
    });
});
