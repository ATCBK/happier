import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import { deleteOwnedSession } from "./deleteOwnedSession";

const PUBLIC_KEY_PREFIX = "session-delete-publication-contention-";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")(
    "owned Session deletion under PostgreSQL publication contention",
    () => {
        let connected = false;

        beforeAll(async () => {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error("Run with the disposable PostgreSQL DB-contract harness");
            }
            vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
            initDbPostgres();
            await db.$connect();
            connected = true;
        });

        afterEach(async () => {
            await db.sessionMessage.deleteMany({
                where: { session: { account: { publicKey: { startsWith: PUBLIC_KEY_PREFIX } } } },
            });
            await db.session.deleteMany({
                where: { account: { publicKey: { startsWith: PUBLIC_KEY_PREFIX } } },
            });
            await db.account.deleteMany({
                where: { publicKey: { startsWith: PUBLIC_KEY_PREFIX } },
            });
        });

        afterAll(async () => {
            if (connected) await db.$disconnect();
            vi.unstubAllEnvs();
        });

        it("commits one guarded delete while a canonical same-Account publisher advances", async () => {
            const account = await db.account.create({
                data: { publicKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`, encryptionMode: "plain" },
            });
            const session = await db.session.create({
                data: {
                    accountId: account.id,
                    tag: randomUUID(),
                    metadata: "{}",
                    encryptionMode: "plain",
                    active: false,
                },
            });
            await db.sessionMessage.create({
                data: {
                    sessionId: session.id,
                    seq: 1,
                    localId: randomUUID(),
                    content: { t: "plain", v: { role: "assistant", content: "delete me" } },
                },
            });

            const transaction = db.$transaction;
            let advanced = false;
            const failedStatements: string[] = [];
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                        get(inner, property, innerReceiver) {
                            if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                            return async (query: string, ...values: unknown[]) => {
                                if (!advanced && query.includes('FROM "Account"') && query.includes("FOR NO KEY UPDATE")) {
                                    advanced = true;
                                    await inTx(async peerTx => {
                                        await markAccountChanged(peerTx, {
                                            accountId: account.id,
                                            kind: "account",
                                            entityId: "contention-peer",
                                        });
                                    }, {
                                        isolationLevel: "ReadCommitted",
                                        transactionClass: "session-delete-contention-peer",
                                    });
                                }
                                try {
                                    return await inner.$queryRawUnsafe(query, ...values);
                                } catch (error) {
                                    failedStatements.push(query);
                                    throw error;
                                }
                            };
                        },
                    })), ...args.slice(1)]);
                },
            });

            try {
                await expect(deleteOwnedSession({
                    sessionId: session.id,
                    ownerAccountId: account.id,
                    reason: "user_request",
                })).resolves.toEqual({ ok: true });
            } finally {
                db.$transaction = transaction;
            }

            expect(advanced).toBe(true);
            expect(failedStatements).toEqual([]);
            expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
            expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 2 });
            expect(await db.accountChange.findMany({
                where: { accountId: account.id },
                orderBy: { cursor: "asc" },
                select: { kind: true, entityId: true, cursor: true },
            })).toEqual([
                { kind: "account", entityId: "contention-peer", cursor: 1 },
                { kind: "session", entityId: session.id, cursor: 2 },
            ]);
        });

        it("keeps the Session and emits no deletion publication when its guarded state changes", async () => {
            const account = await db.account.create({
                data: { publicKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`, encryptionMode: "plain" },
            });
            const session = await db.session.create({
                data: {
                    accountId: account.id,
                    tag: randomUUID(),
                    metadata: "{}",
                    encryptionMode: "plain",
                    active: false,
                },
            });

            const transaction = db.$transaction;
            let changed = false;
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
                        get(inner, property, innerReceiver) {
                            if (property !== "session") return Reflect.get(inner, property, innerReceiver);
                            return new Proxy(inner.session, {
                                get(delegate, method, delegateReceiver) {
                                    const operation = Reflect.get(delegate, method, delegateReceiver);
                                    if (method !== "updateMany") return operation;
                                    return async (...queryArgs: Parameters<typeof tx.session.updateMany>) => {
                                        if (!changed) {
                                            changed = true;
                                            await db.session.update({
                                                where: { id: session.id },
                                                data: { metadataLayoutVersion: { increment: 1 } },
                                            });
                                        }
                                        return Reflect.apply(operation, delegate, queryArgs);
                                    };
                                },
                            });
                        },
                    })), ...args.slice(1)]);
                },
            });

            try {
                await expect(deleteOwnedSession({
                    sessionId: session.id,
                    ownerAccountId: account.id,
                    reason: "user_request",
                })).resolves.toEqual({ ok: false, error: "conflict" });
            } finally {
                db.$transaction = transaction;
            }

            expect(changed).toBe(true);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
                .toMatchObject({ metadataLayoutVersion: 1 });
            expect(await db.accountChange.count({
                where: { accountId: account.id, kind: "session", entityId: session.id },
            })).toBe(0);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 0 });
        });
    },
);
