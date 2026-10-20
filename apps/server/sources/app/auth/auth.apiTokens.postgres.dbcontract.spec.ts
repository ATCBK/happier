import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import { setAccountStatusInTx } from "@/app/home/governance/accountLifecycle";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import { auth } from "./auth";

const PUBLIC_KEY_PREFIX = "api-token-mint-contention-";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")(
    "API-token minting under PostgreSQL Account contention",
    () => {
        let connected = false;

        beforeAll(async () => {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error("Run with the disposable PostgreSQL DB-contract harness");
            }
            vi.stubEnv("AUTH_REQUIRED_LOGIN_PROVIDERS", "");
            vi.stubEnv("HANDY_MASTER_SECRET", "api-token-mint-postgres-secret");
            vi.stubEnv("HAPPIER_DB_TX_MAX_RETRIES", "0");
            initDbPostgres();
            await db.$connect();
            await auth.init();
            connected = true;
        });

        afterEach(async () => {
            await db.account.deleteMany({
                where: { publicKey: { startsWith: PUBLIC_KEY_PREFIX } },
            });
        });

        afterAll(async () => {
            if (connected) await db.$disconnect();
            vi.unstubAllEnvs();
        });

        it("commits a root token while another writer advances the Account before its fence", async () => {
            const account = await db.account.create({
                data: { publicKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`, encryptionMode: "plain" },
            });
            let releaseWriter!: () => void;
            let signalWriter!: () => void;
            const writerHeld = new Promise<void>((resolve) => { signalWriter = resolve; });
            const writerRelease = new Promise<void>((resolve) => { releaseWriter = resolve; });
            const writing = inTx(async peerTx => {
                await peerTx.account.update({
                    where: { id: account.id },
                    data: { seq: { increment: 1 } },
                });
                signalWriter();
                await writerRelease;
            }, {
                isolationLevel: "ReadCommitted",
                transactionClass: "api-token-mint-contention-peer",
            });
            await writerHeld;

            const transaction = db.$transaction;
            let signalFence!: () => void;
            const fenceReached = new Promise<void>((resolve) => { signalFence = resolve; });
            db.$transaction = new Proxy(transaction, {
                apply(target, receiver, args: unknown[]) {
                    const callback = args[0];
                    if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                    return Reflect.apply(target, receiver, [async (tx: Tx) => {
                        // Materialize the transaction snapshot while the peer's new
                        // Account version is uncommitted. This recreates the observed
                        // PostgreSQL attempt in which the later fence saw that version
                        // commit: Serializable aborts, while the fenced ReadCommitted
                        // owner waits and then consumes the committed row.
                        await tx.$queryRawUnsafe(
                            'SELECT "id" FROM "Account" WHERE "id" = $1',
                            account.id,
                        );
                        return callback(new Proxy(tx, {
                            get(inner, property, innerReceiver) {
                                if (property !== "$queryRawUnsafe") {
                                    return Reflect.get(inner, property, innerReceiver);
                                }
                                return async (query: string, ...values: unknown[]) => {
                                    if (query.includes('FROM "Account"') && query.includes("FOR UPDATE")) {
                                        signalFence();
                                    }
                                    return inner.$queryRawUnsafe(query, ...values);
                                };
                            },
                        }));
                    }, ...args.slice(1)]);
                },
            });

            const tokenId = randomUUID();
            const minting = auth.createApiToken({
                accountId: account.id,
                tokenId,
                label: "Concurrent root mint",
            });
            const mintAssertion = expect(minting).resolves.toMatchObject({ tokenId });
            try {
                await fenceReached;
                releaseWriter();
                await writing;
                await mintAssertion;
            } finally {
                releaseWriter();
                await writing.catch(() => undefined);
                db.$transaction = transaction;
            }

            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(1);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } }))
                .toEqual({ seq: 1 });
        });

        it("does not mint a live credential after a waiting Account disable commits", async () => {
            const account = await db.account.create({
                data: { publicKey: `${PUBLIC_KEY_PREFIX}${randomUUID()}`, encryptionMode: "plain" },
            });
            let releaseFence!: () => void;
            let signalFence!: () => void;
            const held = new Promise<void>((resolve) => { signalFence = resolve; });
            const release = new Promise<void>((resolve) => { releaseFence = resolve; });
            const disabling = inTx(async tx => {
                await acquireAccountSessionOwnerMetadataFenceInTx(tx, account.id, "exclusive");
                await setAccountStatusInTx(tx, {
                    actorAccountId: account.id,
                    targetAccountId: account.id,
                    status: "disabled",
                    authority: "account_erasure",
                });
                signalFence();
                await release;
            });
            await held;

            const minting = auth.createApiToken({
                accountId: account.id,
                tokenId: randomUUID(),
                label: "Waiting root mint",
            });
            releaseFence();
            await disabling;

            await expect(minting).rejects.toMatchObject({ code: "account-disabled" });
            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
        });
    },
);
