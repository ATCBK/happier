import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AccountNameUpdateResponseV1Schema } from "@happier-dev/protocol/account/profile";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { registerAccountProfileRoute } from "./registerAccountProfileRoute";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { acquireAccountChangePublicationLocksInTx, markAccountChanged } from "@/app/changes/markAccountChanged";
import { eventRouter } from "@/app/events/eventRouter";

function latch() {
    let release!: () => void;
    return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Account name terminal assignment", () => {
    beforeAll(async () => {
        if (!process.env.DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it("allows ordinary Session domain work while the public name assignment holds its Account row", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: "{}", encryptionMode: "plain" } });
        const assigned = latch(), release = latch();
        const transaction = db.$transaction;
        let namePid = 0;
        let sessionPid = 0;
        let sessionInDomain = false;
        let sessionSettled = false;
        let intercepted = false;
        const emitted = vi.spyOn(eventRouter, "emitUpdate");
        // Prisma is the real database boundary. Pause only after the native
        // name UPDATE; admission, publication, route and event logic stay real.
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
            return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property !== "account") return Reflect.get(inner, property, innerReceiver);
                return new Proxy(inner.account, { get(model, method, modelReceiver) {
                    if (method !== "update") return Reflect.get(model, method, modelReceiver);
                    return async (...queryArgs: unknown[]) => {
                        const query = queryArgs[0];
                        const result = await Reflect.apply(model.update, model, queryArgs);
                        if (!intercepted && typeof query === "object" && query !== null && "data" in query
                            && typeof query.data === "object" && query.data !== null && "name" in query.data) {
                            intercepted = true;
                            [{ pid: namePid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                            assigned.release();
                            await release.promise;
                        }
                        return result;
                    };
                } });
            } })), ...args.slice(1)]);
        } });
        try {
            await withAuthenticatedTestApp(registerAccountProfileRoute, async app => {
                const nameWrite = app.inject({ method: "POST", url: "/v1/account/profile",
                    headers: { "x-test-user-id": account.id }, payload: { name: "Captain" } });
                const nameOutcome = Promise.allSettled([nameWrite]);
                let writerOutcome: Promise<PromiseSettledResult<void>[]> | undefined;
                try {
                    await Promise.race([assigned.promise, nameWrite.then(() => { throw new Error("Name write did not reach assignment"); })]);
                    const writer = inTx(async tx => {
                        [{ pid: sessionPid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                        await acquireAccountChangePublicationLocksInTx(tx, [account.id], { includeSingleAccount: true });
                        await tx.session.update({ where: { id: session.id }, data: { metadata: '{"changed":true}' } });
                        sessionInDomain = true;
                        await markAccountChanged(tx, { accountId: account.id, kind: "session", entityId: session.id });
                    }).finally(() => { sessionSettled = true; });
                    writerOutcome = Promise.allSettled([writer]);
                    while (!sessionInDomain && !sessionSettled) {
                        const [sample] = await db.$queryRaw<Array<{ blockers: number[] }>>`
                            SELECT pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = ${sessionPid}
                        `;
                        if (sample?.blockers.includes(namePid)) break;
                    }
                    expect(sessionInDomain).toBe(true);
                } finally {
                    release.release();
                    for (const outcome of await writerOutcome ?? []) if (outcome.status === "rejected") throw outcome.reason;
                    await nameOutcome;
                }
                const response = await nameWrite;
                expect(response.statusCode).toBe(200);
                expect(AccountNameUpdateResponseV1Schema.parse(response.json())).toMatchObject({ name: "Captain", firstName: "Captain", lastName: null });
                const change = await db.accountChange.findUniqueOrThrow({ where: { accountId_kind_entityId: {
                    accountId: account.id, kind: "account", entityId: "self",
                } } });
                expect(change.hint).toEqual({ name: true });
                expect(emitted.mock.calls.map(([event]) => event)).toContainEqual(expect.objectContaining({
                    userId: account.id, recipientFilter: { type: "user-scoped-only" },
                    payload: expect.objectContaining({ seq: change.cursor, body: expect.objectContaining({ name: "Captain" }) }),
                }));
                expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { name: true } })).toEqual({ name: "Captain" });
            });
        } finally {
            release.release();
            db.$transaction = transaction;
            emitted.mockRestore();
            await db.session.delete({ where: { id: session.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
