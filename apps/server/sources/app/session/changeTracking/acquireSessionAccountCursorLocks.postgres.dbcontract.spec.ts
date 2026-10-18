import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { encodeAutomationSessionLifecycleConfiguration } from "@/app/automations/automationSessionLifecycleConfigurationCodec";
import { prepareSessionAccountCursorLocks } from "./acquireSessionAccountCursorLocksInTx";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Prepared Session cursor audience", () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it("replays a changed incoming-child audience and fences outgoing, incoming and Archive lifecycle Accounts", async () => {
        const accounts = await Promise.all(Array.from({ length: 6 }, () => db.account.create({
            data: { publicKey: randomUUID(), encryptionMode: "plain" },
        })));
        const [sourceOwner, leadOwner, childOwner, automationOwner, scopeOwner, recipient] = accounts;
        try {
            const createSession = (accountId: string) => db.session.create({ data: {
                accountId, tag: randomUUID(), metadata: "{}", encryptionMode: "plain",
            } });
            const source = await createSession(sourceOwner.id);
            const lead = await createSession(leadOwner.id);
            const child = await createSession(childOwner.id);
            const scope = await createSession(scopeOwner.id);
            await db.sessionReportsTo.createMany({ data: [
                { sessionId: source.id, leadSessionId: lead.id },
                { sessionId: child.id, leadSessionId: source.id },
            ] });
            const automation = await db.automation.create({ data: {
                accountId: automationOwner.id, name: "Archive audience", templateCiphertext: "{}", scopeSessionId: scope.id,
            } });
            await db.automationTrigger.create({ data: {
                automationId: automation.id, kind: "sessionLifecycle",
                ...encodeAutomationSessionLifecycleConfiguration({
                    kind: "sessionLifecycle", sourceSessionId: source.id,
                    events: ["sessionArchived"], policy: { kind: "everyMatch" },
                }),
            } });
            let preparations = 0;
            await inTx(async tx => {
                expect(preparations).toBe(2);
                expect(await tx.$queryRaw<Array<{ isolation: string }>>`
                    SELECT current_setting('transaction_isolation') AS isolation
                `).toEqual([{ isolation: "serializable" }]);
                // Each independent contender must observe the actual row fence;
                // checking a union would hide a missing later audience member.
                for (const account of accounts) {
                    await expect(db.$queryRaw`
                        SELECT id FROM "Account" WHERE id = ${account.id} FOR NO KEY UPDATE NOWAIT
                    `).rejects.toMatchObject({ code: "P2010", meta: { code: "55P03" } });
                }
            }, {
                isolationLevel: "Serializable",
                prepare: async () => {
                    preparations += 1;
                    const fence = await prepareSessionAccountCursorLocks([source.id], [], { includeLifecyclePublications: true });
                    if (preparations === 1) {
                        // A real committed grant between discovery and mutation
                        // must refresh the whole sorted fence, never extend it.
                        await db.sessionShare.create({ data: {
                            sessionId: child.id, sharedByUserId: childOwner.id, sharedWithUserId: recipient.id,
                        } });
                    }
                    return fence;
                },
            });
        } finally {
            await db.session.deleteMany({ where: { accountId: { in: accounts.map(account => account.id) } } });
            await db.account.deleteMany({ where: { id: { in: accounts.map(account => account.id) } } });
        }
    });
});
