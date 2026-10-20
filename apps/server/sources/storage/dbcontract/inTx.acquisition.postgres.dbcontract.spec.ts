import { createConnection, createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbPostgres } from "@/storage/db";
import { afterTx, inTx } from "@/storage/inTx";
import { createDbMaintenanceClient, getDbProviderFromEnv, type PrismaClientType } from "@/storage/prisma";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("native transaction acquisition expiry", () => {
    let observer: PrismaClientType;
    const originalUrl = process.env.DATABASE_URL;
    const originalRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
    const sockets = new Set<Socket>();
    let delayResponse: (() => Promise<void>) | undefined;
    // Delay the actual database response, not Prisma/inTx logic. This models a
    // proxy-queued BEGIN after Prisma has acquired its own pool connection.
    const proxy = createServer(downstream => {
        const target = new URL(originalUrl!);
        const upstream = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
        sockets.add(downstream); sockets.add(upstream);
        downstream.pipe(upstream);
        upstream.on("data", async data => {
            const hold = delayResponse;
            if (hold) {
                delayResponse = undefined;
                upstream.pause();
                await hold();
                downstream.write(data);
                upstream.resume();
            } else downstream.write(data);
        });
        downstream.on("close", () => { sockets.delete(downstream); upstream.destroy(); });
        upstream.on("close", () => { sockets.delete(upstream); downstream.destroy(); });
        downstream.on("error", () => upstream.destroy());
        upstream.on("error", () => downstream.destroy());
    });

    beforeAll(async () => {
        if (!originalUrl || originalUrl !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
        const address = proxy.address();
        if (!address || typeof address === "string") throw new Error("Missing proxy listener");
        const url = new URL(originalUrl);
        url.hostname = "127.0.0.1"; url.port = String(address.port);
        url.searchParams.set("connection_limit", "1");
        process.env.DATABASE_URL = url.href;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        observer = await createDbMaintenanceClient("postgres", originalUrl);
        initDbPostgres();
        await Promise.all([db.$connect(), observer.$connect()]);
        await db.$queryRaw`SELECT 1`;
    });

    afterAll(async () => {
        await Promise.all([db.$disconnect(), observer?.$disconnect()]);
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => proxy.close(() => resolve()));
        if (originalUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalUrl;
        if (originalRetries === undefined) delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
        else process.env.HAPPIER_DB_TX_MAX_RETRIES = originalRetries;
    });

    it.each(["acquisition", "request"] as const)("rejects a late BEGIN at the %s boundary before user work or afterTx", async boundary => {
        const account = await observer.account.create({ data: { publicKey: randomUUID() } });
        let entered = false;
        let committed = false;
        let received!: () => void;
        const beginReceived = new Promise<void>(resolve => { received = resolve; });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        delayResponse = () => { received(); return released; };
        const startedAtMs = Date.now();
        const outcome = Promise.allSettled([inTx(async tx => {
            entered = true;
            await tx.account.update({ where: { id: account.id }, data: { seq: { increment: 1 } } });
            afterTx(tx, () => { committed = true; });
        }, { maxWaitMs: 300, timeoutMs: 5_000,
            ...(boundary === "request" ? { deadlineAtMs: startedAtMs + 400 } : {}) })]);
        try {
            await beginReceived;
            await new Promise(resolve => setTimeout(resolve, 800));
        } finally { release(); }
        try {
            const [result] = await outcome;
            console.info("LATE_BEGIN", { boundary, elapsedMs: Date.now() - startedAtMs, entered, committed, status: result.status });
            expect(result).toMatchObject({ status: "rejected", reason: { name: boundary === "acquisition"
                ? "TransactionAcquisitionUnavailableError" : "TransactionDeadlineExceededError" } });
            expect(entered).toBe(false);
            expect(committed).toBe(false);
            expect(await observer.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual({ seq: 0 });
            await expect(inTx(async tx => tx.$queryRaw`SELECT 2::int AS value`)).resolves.toEqual([{ value: 2 }]);
        } finally { await observer.account.delete({ where: { id: account.id } }); }
    });
});
