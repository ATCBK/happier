import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { readArtifactBatchForCaller } from "./artifactAccessService";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Artifact batch PostgreSQL connection occupancy", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(["plain", "e2ee"] as const)("keeps %s batch database operations independent of retained document count", async mode => {
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === "e2ee" ? createSignedAccountContentBinding() : {}) } });
        // The failing live request selected 500 documents; this is a measured workload, not a product limit.
        const ids = Array.from({ length: 500 }, () => randomUUID());
        const header = mode === "plain" ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: "Batch occupancy" }))
            : new TextEncoder().encode("opaque header");
        const body = mode === "plain" ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: "Captured revision" }))
            : new TextEncoder().encode("opaque body");
        const key = mode === "plain" ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
            : sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes });
        const transaction = db.$transaction;
        const samples: Array<{ callbackMs: number; databaseOperations: number }> = [];
        try {
            await db.artifact.createMany({ data: ids.map(id => ({ id, accountId: owner.id,
                header, body, dataEncryptionKey: key, headerVersion: 1, bodyVersion: 1 })) });
            // Observe the genuine Prisma boundary. Every query, policy projection,
            // signature verification and transaction still executes normally.
            db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    const sample = { callbackMs: 0, databaseOperations: 0 };
                    samples.push(sample);
                    const started = performance.now();
                    try {
                        return await callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                            if (property !== "artifact" && property !== "account" && property !== "publicSessionShare"
                                && property !== "artifactKeyEnvelope") return Reflect.get(inner, property, innerReceiver);
                            const delegate = inner[property];
                            return new Proxy(delegate, { get(ownerDelegate, method, delegateReceiver) {
                                const operation = Reflect.get(ownerDelegate, method, delegateReceiver);
                                if (typeof operation !== "function") return operation;
                                return (...queryArgs: unknown[]) => {
                                    sample.databaseOperations += 1;
                                    return Reflect.apply(operation, ownerDelegate, queryArgs);
                                };
                            } });
                        } }));
                    } finally { sample.callbackMs = performance.now() - started; }
                }, ...args.slice(1)]);
            } });
            const measure = async (artifactIds: string[]) => {
                samples.length = 0;
                const started = performance.now();
                const result = await readArtifactBatchForCaller({ actorAccountId: owner.id, artifactIds });
                expect(result).toHaveLength(artifactIds.length);
                expect(result.every(item => item.read.ok && item.read.artifact.access === "owner"
                    && item.read.artifact.bodyVersion === 1)).toBe(true);
                return { documents: artifactIds.length, elapsedMs: performance.now() - started,
                    databaseOperations: samples.reduce((total, sample) => total + sample.databaseOperations, 0),
                    transactionCallbacksMs: samples.map(sample => sample.callbackMs) };
            };
            const single = await measure(ids.slice(0, 1));
            const retained = await measure(ids);
            console.info("ARTIFACT_BATCH_OCCUPANCY", JSON.stringify({ mode, single, retained }));
            expect(single.databaseOperations).toBeGreaterThan(0);
            expect(retained.databaseOperations).toBe(single.databaseOperations);
        } finally {
            db.$transaction = transaction;
            await db.artifact.deleteMany({ where: { accountId: owner.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
});
