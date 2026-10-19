import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readDatabaseTransactionConfigFromEnv } from "@/config/databaseTransactions";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { afterTx, inTx, type Tx } from "@/storage/inTx";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("PostgreSQL expired transaction recovery", () => {
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

    it("retries an expired P2028 publication within the existing budget without repeating its committed effect", async () => {
        const config = readDatabaseTransactionConfigFromEnv(process.env, "postgres");
        expect(config.maxRetries).toBeGreaterThan(0);
        const effect = await db.account.create({ data: { publicKey: randomUUID() } });
        const publication = await db.account.create({ data: { publicKey: randomUUID() } });
        let effectAttempts = 0;
        let publicationAttempts = 0;
        let expiredError: unknown;
        const publishedAttempts: number[] = [];
        const transaction = db.$transaction;

        try {
            // The effect commits before terminal publication, as it does for
            // Approval settlement. Recovery must surround only publication.
            effectAttempts += 1;
            await db.account.update({ where: { id: effect.id }, data: { seq: { increment: 1 } } });

            // Database-boundary fault: finish the first callback's SQL, then
            // let Prisma expire the real transaction before its next query.
            // This produces a native P2028 and a real PostgreSQL rollback;
            // the classifier, retry loop and afterTx owner stay unchanged.
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        const result = await callback(tx);
                        if (publicationAttempts === 1) {
                            await new Promise(resolve => setTimeout(resolve, config.timeoutMs + 1));
                            try {
                                await tx.$queryRaw`SELECT 1::int AS value`;
                            } catch (error) {
                                expiredError = error;
                                throw error;
                            }
                            throw new Error("Expected Prisma to reject a query after transaction expiry");
                        }
                        return result;
                    }, ...args.slice(1)]);
                },
            });

            const result = await inTx(async tx => {
                const attempt = ++publicationAttempts;
                const receipt = await tx.account.update({ where: { id: publication.id },
                    data: { seq: { increment: 1 } }, select: { seq: true } });
                afterTx(tx, () => { publishedAttempts.push(attempt); });
                return receipt;
            }, { transactionClass: "test-expired-terminal-publication" });

            expect(expiredError).toMatchObject({ code: "P2028", meta: {
                error: expect.stringContaining("A query cannot be executed on an expired transaction"),
            } });
            expect(publicationAttempts).toBe(2);
            expect(publicationAttempts - 1).toBeLessThanOrEqual(config.maxRetries);
            expect(result).toEqual({ seq: 1 });
            expect(publishedAttempts).toEqual([2]);
            expect(effectAttempts).toBe(1);
            expect(await db.account.findUniqueOrThrow({ where: { id: effect.id }, select: { seq: true } }))
                .toEqual({ seq: 1 });
            expect(await db.account.findUniqueOrThrow({ where: { id: publication.id }, select: { seq: true } }))
                .toEqual({ seq: 1 });
        } finally {
            db.$transaction = transaction;
            await db.account.deleteMany({ where: { id: { in: [effect.id, publication.id] } } });
        }
    });
});
