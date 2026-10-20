import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireAccountEncryptionTransitionFenceInTx } from "@/app/encryption/accountEncryptionTransition";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createUsageSnapshot } from "../providerAccountUsageTestkit";
import { writeProviderAccountUsageRecordWithPolicy } from "./routeWritePolicy";
import { ProviderAccountUsagePayloadInvariantError } from "./types";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Provider usage Account admission", () => {
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

    it("refuses old-mode usage when a mode transition wins admission on a passed ReadCommitted client", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() - 1_000 });
        const binding = createSignedAccountContentBinding();
        let transitioned = false;
        await expect(inTx(async tx => {
            const client = new Proxy(tx, { get(inner, property, receiver) {
                if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, receiver);
                return async (query: string, ...values: unknown[]) => {
                    // Advance the real transition immediately before usage
                    // admission. The mode read must follow this boundary.
                    if (!transitioned && query.includes('FROM "Account"') && query.includes("FOR ")) {
                        transitioned = true;
                        await inTx(async peer => {
                            expect((await acquireAccountEncryptionTransitionFenceInTx(peer, account.id, "exclusive")).status).toBe("ready");
                            await peer.account.update({ where: { id: account.id }, data: { encryptionMode: "e2ee", ...binding } });
                        });
                    }
                    return inner.$queryRawUnsafe(query, ...values);
                };
            } });
            return writeProviderAccountUsageRecordWithPolicy({ client, accountId: account.id,
                recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: "plain_json_v1", status: "ok",
                fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs, snapshot });
        })).rejects.toBeInstanceOf(ProviderAccountUsagePayloadInvariantError);
        expect(transitioned).toBe(true);
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: account.id } })).toBe(0);
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { encryptionMode: true } })).encryptionMode).toBe("e2ee");
    });
});
