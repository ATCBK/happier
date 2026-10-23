import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
import { ArtifactReadBatchResponseV1Schema } from "@happier-dev/protocol/artifacts/artifactAccessV1";
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from "@happier-dev/protocol/server/http/requestBodyBoundsV1";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { readArtifactBatchForCaller } from "./artifactAccessService";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { artifactsRoutes } from "@/app/api/routes/artifacts/artifactsRoutes";

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

    it("serves the reproduced 35000-id HTTP read without exceeding PostgreSQL binds or widening access", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const stranger = await db.account.create({ data: { encryptionMode: "plain" } });
        const stored = {
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: "Selected native PostgreSQL document" })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: "Authorized content" })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1,
        };
        const readable = await db.artifact.create({ data: { ...stored, id: randomUUID(), accountId: owner.id } });
        const inaccessible = await db.artifact.create({ data: { ...stored, id: randomUUID(), accountId: stranger.id } });
        // Bind pressure depends on addressed identities, not on how many rows exist.
        // Keep both a real authorized row and a real inaccessible row in that demand.
        const artifactIds = [readable.id, inaccessible.id, ...Array.from({ length: 34998 }, () => randomUUID())];
        try {
            await withAuthenticatedTestApp(artifactsRoutes, async app => {
                const response = await app.inject({ method: "POST", url: "/v1/artifacts/read",
                    headers: { "x-test-user-id": owner.id,
                        "x-happier-account-stored-content-protocol": String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) },
                    payload: { artifactIds } });
                expect(response.statusCode, response.body).toBe(200);
                const result = ArtifactReadBatchResponseV1Schema.parse(response.json());
                expect(result.items.map(item => item.artifactId)).toEqual(artifactIds);
                expect(result.items.filter(item => item.ok)).toMatchObject([
                    { artifactId: readable.id, artifact: { ownerAccountId: owner.id, access: "owner", bodyVersion: 1 } },
                ]);
                expect(result.items.slice(1).every(item => !item.ok && item.status === 404)).toBe(true);
            }, { bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 });
        } finally {
            await db.artifact.deleteMany({ where: { id: { in: [readable.id, inaccessible.id] } } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
        }
    });

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
