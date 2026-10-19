import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from "@happier-dev/protocol";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import type { Tx } from "@/storage/inTx";
import { updateArtifactHttpMutation } from "./artifactMutationHttpResponse";
import { createArtifact, updateArtifact } from "./artifactWriteService";
import { readArtifactStorageUsageInTx } from "./artifactStorageService";
import { inTx } from "@/storage/inTx";
import { setArtifactAccessGrantInTx } from "./artifactAccessService";

const bytes = (value: unknown) => privacyKit.decodeBase64(encodePlainArtifactStoredContent(value));

async function plainArtifact(accountId: string) {
    return db.artifact.create({ data: {
        id: randomUUID(), accountId, header: bytes({ kind: "approval_request.v1" }), body: bytes({ status: "open" }),
        dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER), headerVersion: 1, bodyVersion: 1,
    } });
}

/** Advance a genuine peer after audience discovery but before the first Account lock. */
function beforeArtifactAccountLock(artifactId: string, peer: () => Promise<void>) {
    const transaction = db.$transaction;
    let advanced = false;
    db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => {
            let addressed = false;
            return callback(new Proxy(tx, { get(inner, property, innerReceiver) {
                if (property === "artifact") return new Proxy(inner.artifact, { get(delegate, method, delegateReceiver) {
                    const operation = Reflect.get(delegate, method, delegateReceiver);
                    if (method !== "findFirst") return operation;
                    return (...queryArgs: Parameters<typeof tx.artifact.findFirst>) => {
                        if (queryArgs[0]?.where?.id === artifactId) addressed = true;
                        return Reflect.apply(operation, delegate, queryArgs);
                    };
                } });
                if (property !== "$queryRawUnsafe") return Reflect.get(inner, property, innerReceiver);
                return async (query: string, ...values: unknown[]) => {
                    if (addressed && !advanced && query.includes('FROM "Account"') && query.includes("FOR ")) {
                        advanced = true;
                        await peer();
                    }
                    return inner.$queryRawUnsafe(query, ...values);
                };
            } }));
        }, ...args.slice(1)]);
    } });
    return () => { db.$transaction = transaction; expect(advanced).toBe(true); };
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Artifact writes under PostgreSQL publication contention", () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it("commits an approval update while another Artifact publishes changes on the same Account", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const approval = await plainArtifact(account.id);
        const catalog = await plainArtifact(account.id);
        let peerVersion = 1;
        const failures: Array<{ operation: string; code?: unknown; model?: unknown }> = [];
        const transaction = db.$transaction;
        // Interleave at the real database boundary. Both writers, access checks,
        // storage accounting, revision retention and publication stay real.
        db.$transaction = new Proxy(transaction, {
            apply(target, receiver, args: unknown[]) {
                const callback = args[0];
                if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
                return Reflect.apply(target, receiver, [async (tx: Tx) => {
                    let approvalRead = false;
                    let advanced = false;
                    const advancePeer = async () => {
                        if (advanced) return;
                        advanced = true;
                        const peer = await updateArtifact({ actorUserId: account.id, artifactId: catalog.id,
                            body: { bytes: bytes({ revision: peerVersion + 1 }), expectedVersion: peerVersion } });
                        expect(peer.ok).toBe(true);
                        peerVersion += 1;
                    };
                    return callback(new Proxy(tx, {
                    get(inner, property, innerReceiver) {
                        if (property === "$queryRawUnsafe") return async (query: string, ...values: unknown[]) => {
                            if (approvalRead && query.includes('FROM "Account"') && query.includes("FOR ")) await advancePeer();
                            return inner.$queryRawUnsafe(query, ...values);
                        };
                        if (property !== "artifact") return Reflect.get(inner, property, innerReceiver);
                        return new Proxy(inner.artifact, {
                            get(delegate, method, delegateReceiver) {
                                const operation = Reflect.get(delegate, method, delegateReceiver);
                                if (method === "findFirst") return (...queryArgs: Parameters<typeof tx.artifact.findFirst>) => {
                                    if (queryArgs[0]?.where?.id === approval.id) approvalRead = true;
                                    return Reflect.apply(operation, delegate, queryArgs);
                                };
                                if (method !== "updateMany") return operation;
                                return async (...queryArgs: Parameters<typeof tx.artifact.updateMany>) => {
                                    if (queryArgs[0]?.where?.id === approval.id) await advancePeer();
                                    try { return await Reflect.apply(operation, delegate, queryArgs); }
                                    catch (error) {
                                        const diagnostic = error as { code?: unknown; meta?: { modelName?: unknown } };
                                        failures.push({ operation: "Artifact.updateMany", code: diagnostic.code, model: diagnostic.meta?.modelName });
                                        throw error;
                                    }
                                };
                            },
                        });
                    },
                }));
                }, ...args.slice(1)]);
            },
        });
        try {
            const result = await updateArtifactHttpMutation(account.id, approval.id, {
                body: encodePlainArtifactStoredContent({ status: "approved" }), expectedBodyVersion: 1,
            });
            console.info("ARTIFACT_CONTENTION", JSON.stringify({ peerWrites: peerVersion - 1, failures, statusCode: result.statusCode }));
            expect(result.statusCode).toBe(200);
            expect(peerVersion).toBeGreaterThan(1);
            expect(result.body).toMatchObject({ success: true });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: approval.id }, select: { bodyVersion: true, seq: true } }))
                .toEqual({ bodyVersion: 2, seq: 1 });
        } finally {
            db.$transaction = transaction;
        }
    });

    it("preserves independent header/body versions, head sequence and displaced body under concurrent writes", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(account.id);
        const outcomes = await Promise.all([
            updateArtifact({ actorUserId: account.id, artifactId: artifact.id,
                header: { bytes: bytes({ kind: "approval_request.v1", decided: true }), expectedVersion: 1 } }),
            updateArtifact({ actorUserId: account.id, artifactId: artifact.id,
                body: { bytes: bytes({ status: "approved" }), expectedVersion: 1 } }),
        ]);
        expect(outcomes.map(result => result.ok)).toEqual([true, true]);
        expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.id }, select: { headerVersion: true, bodyVersion: true, seq: true } }))
            .toEqual({ headerVersion: 2, bodyVersion: 2, seq: 2 });
        const revisions = await db.artifactRevision.findMany({ where: { artifactId: artifact.id }, select: { bodyVersion: true, body: true } });
        expect(revisions.map(row => row.bodyVersion)).toEqual([1]);
        expect(Buffer.compare(Buffer.from(revisions[0].body), Buffer.from(artifact.body))).toBe(0);
    });

    it("admits one winner for two simultaneous decisions at the same body version", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(account.id);
        const outcomes = await Promise.all(["approved", "canceled"].map(status => updateArtifact({ actorUserId: account.id,
            artifactId: artifact.id, body: { bytes: bytes({ status }), expectedVersion: 1 } })));
        expect(outcomes.filter(result => result.ok)).toHaveLength(1);
        expect(outcomes.filter(result => !result.ok).map(result => result.error)).toEqual(["version-mismatch"]);
        expect(await db.artifactRevision.count({ where: { artifactId: artifact.id } })).toBe(1);
    });

    it("keeps Account quota admission atomic across concurrent Artifact creates", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const header = bytes({ kind: "document" });
        const body = bytes({ value: "content" });
        vi.stubEnv("HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES", String(header.byteLength + body.byteLength));
        try {
            const outcomes = await Promise.all([randomUUID(), randomUUID()].map(artifactId => createArtifact({
                actorUserId: account.id, artifactId, header, body,
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            })));
            expect(outcomes.filter(result => result.ok)).toHaveLength(1);
            expect(outcomes.filter(result => !result.ok).map(result => result.error)).toEqual(["quota_exceeded"]);
            expect((await inTx(tx => readArtifactStorageUsageInTx(tx, account.id))).usedBytes).toBe(header.byteLength + body.byteLength);
        } finally { vi.unstubAllEnvs(); }
    });

    it("keeps retained-body quota admission atomic across concurrent Artifact updates", async () => {
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifacts = await Promise.all([plainArtifact(account.id), plainArtifact(account.id)]);
        const baseline = (await inTx(tx => readArtifactStorageUsageInTx(tx, account.id))).usedBytes;
        const body = bytes({ value: "replacement content" });
        vi.stubEnv("HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES", String(baseline + body.byteLength));
        try {
            const outcomes = await Promise.all(artifacts.map(artifact => updateArtifact({ actorUserId: account.id,
                artifactId: artifact.id, body: { bytes: body, expectedVersion: 1 } })));
            expect(outcomes.filter(result => result.ok)).toHaveLength(1);
            expect(outcomes.filter(result => !result.ok).map(result => result.error)).toEqual(["quota_exceeded"]);
            expect((await inTx(tx => readArtifactStorageUsageInTx(tx, account.id))).usedBytes).toBe(baseline + body.byteLength);
        } finally { vi.unstubAllEnvs(); }
    });

    it("replays an expanded audience before publishing to a newly granted recipient", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(owner.id);
        const restore = beforeArtifactAccountLock(artifact.id, async () => {
            expect((await inTx(tx => setArtifactAccessGrantInTx(tx, { artifactId: artifact.id, actorAccountId: owner.id,
                principal: { kind: "account", accountId: recipient.id }, accessLevel: "view" }), { isolationLevel: "Serializable" })).ok).toBe(true);
        });
        try {
            const result = await updateArtifact({ actorUserId: owner.id, artifactId: artifact.id,
                body: { bytes: bytes({ status: "approved" }), expectedVersion: 1 } });
            expect(result.ok).toBe(true);
            if (!result.ok) throw new Error("Expected expanded-audience write to commit");
            expect(result.recipientUpdates.map(row => row.accountId).sort()).toEqual([owner.id, recipient.id].sort());
        } finally { restore(); }
    });

    it("rejects an editor downgraded while its publication locks are being acquired", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const editor = await db.account.create({ data: { encryptionMode: "plain" } });
        const artifact = await plainArtifact(owner.id);
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: editor.id,
            accessLevel: "edit", createdByAccountId: owner.id } });
        const restore = beforeArtifactAccountLock(artifact.id, async () => {
            expect((await inTx(tx => setArtifactAccessGrantInTx(tx, { artifactId: artifact.id, actorAccountId: owner.id,
                principal: { kind: "account", accountId: editor.id }, accessLevel: "view" }), { isolationLevel: "Serializable" })).ok).toBe(true);
        });
        try {
            expect(await updateArtifact({ actorUserId: editor.id, artifactId: artifact.id,
                body: { bytes: bytes({ status: "approved" }), expectedVersion: 1 } })).toMatchObject({ ok: false, error: "not-found" });
            expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id }, select: { bodyVersion: true } })).bodyVersion).toBe(1);
        } finally { restore(); }
    });
});
