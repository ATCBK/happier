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

    it("recovers an expired callback after Prisma evicts its closed-transaction diagnostic", async () => {
        const config = readDatabaseTransactionConfigFromEnv(process.env, "postgres");
        const account = await db.account.create({ data: { publicKey: randomUUID() } });
        const transaction = db.$transaction;
        let attempts = 0;
        let expiredError: unknown;
        let evictedError: unknown;
        const publications: number[] = [];
        try {
            // Prisma6.19.2 ItxManager retains the last100 closed transactions.
            // Expiry first proves rollback; churn then removes only its message,
            // reproducing a live callback whose next SQL receives P2028 NotFound.
            // This adapter owns the native fault; inTx and its callback stay real.
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        if (attempts === 0) {
                            await new Promise(resolve => setTimeout(resolve, config.timeoutMs + 1));
                            try { await tx.$queryRaw`SELECT 1::int AS value`; }
                            catch (error) { expiredError = error; }
                            for (let i = 0; i < 101; i += 1) {
                                await Reflect.apply(target, receiver, [
                                    async (other: Tx) => { await other.$queryRaw`SELECT 1::int AS value`; },
                                    { timeout: config.timeoutMs, maxWait: config.maxWaitMs },
                                ]);
                            }
                            // The native manager moves closed entries into its
                            // diagnostic cache when their own timeout task fires.
                            await new Promise(resolve => setTimeout(resolve, config.timeoutMs + 1));
                            attempts += 1;
                            try { return await callback(tx); }
                            catch (error) { evictedError = error; throw error; }
                        }
                        attempts += 1;
                        return await callback(tx);
                    }, ...args.slice(1)]);
                },
            });
            const result = await inTx(async tx => {
                const receipt = await tx.account.update({ where: { id: account.id },
                    data: { seq: { increment: 1 } }, select: { seq: true } });
                afterTx(tx, () => { publications.push(attempts); });
                return receipt;
            }, { transactionClass: "test-evicted-expired-callback" });
            expect(expiredError).toMatchObject({ code: "P2028", meta: {
                error: expect.stringContaining("expired transaction"),
            } });
            expect(evictedError).toMatchObject({ code: "P2028", meta: {
                error: expect.stringContaining("Transaction not found"),
            } });
            expect(result).toEqual({ seq: 1 });
            expect(attempts).toBe(2);
            expect(publications).toEqual([2]);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 1 });
        } finally {
            db.$transaction = transaction;
            await db.account.delete({ where: { id: account.id } });
        }
    });

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
                afterTx(tx, () => {
                    publishedAttempts.push(attempt);
                    // The same error after commit cannot authorize another
                    // transaction or repeat this already-published effect.
                    throw expiredError;
                });
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
