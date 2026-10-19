import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { encodePasswordCredentialFieldV1, type E2eeAccountPasswordCredentialV1 } from "@happier-dev/protocol";
import * as privacyKit from "privacy-kit";
import { applyAccountEncryptionTransitionInTx } from "./accountEncryptionTransition";

describe("Account password credential mode transition", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-password-transition-", initAuth: false, initEncrypt: false, initFiles: false });
    }, 120_000);
    afterAll(async () => { await harness.close(); });
    afterEach(async () => { await db.account.deleteMany(); });

    const sourceCredential = {
        v: 1, kind: "plain_password_hash", hash: {
            v: 1, algorithm: "scrypt", parameters: { n: 16384, r: 8, p: 5, keyLength: 32 },
            salt: encodePasswordCredentialFieldV1(new Uint8Array(16)),
            digest: encodePasswordCredentialFieldV1(new Uint8Array(32)),
        },
    } as const;

    function targetCredential(publicKey: string): E2eeAccountPasswordCredentialV1 {
        return {
            v: 1, kind: "e2ee_password_envelope",
            envelope: {
                v: 1, accountSigningPublicKey: encodePasswordCredentialFieldV1(
                    new Uint8Array(privacyKit.decodeHex(publicKey)),
                ),
                kdf: { algorithm: "argon2id13", salt: encodePasswordCredentialFieldV1(new Uint8Array(16)), opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, outputBytes: 32 },
                cipher: { algorithm: "aes256gcm", nonce: encodePasswordCredentialFieldV1(new Uint8Array(12)), ciphertext: encodePasswordCredentialFieldV1(new Uint8Array(48)) },
            },
            authVerifier: { v: 1, hash: sourceCredential.hash },
        };
    }

    it("preserves the existing mode transition for Accounts without a password", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({ data: {
            id: "passwordless-transition", encryptionMode: "plain", ...binding,
        } });
        expect(await inTx((tx) => applyAccountEncryptionTransitionInTx(tx, {
            accountId: "passwordless-transition", expectedVersion: 0, toMode: "e2ee", contentKey: { kind: "preserve" },
        }))).toMatchObject({ mode: "e2ee" });
        expect(await db.accountPasswordCredential.findUnique({ where: { accountId: "passwordless-transition" } })).toBeNull();
    });

    it("refuses to strand an owned Discussion when no content conversion was supplied", async () => {
        const binding = createSignedAccountContentBinding();
        const account = await db.account.create({ data: { encryptionMode: "plain", ...binding } });
        await db.discussion.create({ data: { ownerAccountId: account.id, encryptionMode: "plain",
            dataEncryptionKey: new Uint8Array([0]), creationLocalId: crypto.randomUUID(),
            creationEqualityEvidenceV1: { kind: "plainDigest", digest: "A".repeat(43) },
            titleContent: { t: "plain", v: { v: 1, title: "Retained conversation" } }, lastMessageAt: new Date() } });
        await expect(inTx(tx => applyAccountEncryptionTransitionInTx(tx, { accountId: account.id,
            expectedVersion: account.seq, toMode: "e2ee", contentKey: { kind: "preserve" } })))
            .rejects.toThrow("discussion_encryption_transition_incomplete");
        expect(await db.account.findUniqueOrThrow({ where: { id: account.id } })).toMatchObject({ encryptionMode: "plain" });
    });

    it("refuses a mode flip that would strand an enrolled password in its source mode", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({ data: {
            id: "password-transition", encryptionMode: "plain", publicKey: binding.publicKey,
            contentPublicKey: binding.contentPublicKey, contentPublicKeySig: binding.contentPublicKeySig,
            AccountPasswordCredential: { create: { revision: 1, credential: sourceCredential } },
        } });
        await expect(inTx((tx) => applyAccountEncryptionTransitionInTx(tx, {
            accountId: "password-transition", expectedVersion: 0, toMode: "e2ee", contentKey: { kind: "preserve" },
        }))).rejects.toThrow();
        expect((await db.account.findUniqueOrThrow({ where: { id: "password-transition" } })).encryptionMode).toBe("plain");
        expect((await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: "password-transition" } })).revision).toBe(1);
    });

    it("commits the target credential and mode together and refuses a stale source revision", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({ data: {
            id: "password-transition", encryptionMode: "plain", ...binding,
            AccountPasswordCredential: { create: { revision: 2, credential: sourceCredential } },
        } });
        const credential = targetCredential(binding.publicKey);
        const apply = (expectedRevision: number) => inTx((tx) => applyAccountEncryptionTransitionInTx(tx, {
            accountId: "password-transition", expectedVersion: 0, toMode: "e2ee", contentKey: { kind: "preserve" },
            passwordCredential: { expectedRevision, credential },
        }));
        await expect(apply(1)).rejects.toThrow();
        expect((await db.account.findUniqueOrThrow({ where: { id: "password-transition" } })).encryptionMode).toBe("plain");
        expect(await apply(2)).toMatchObject({ mode: "e2ee" });
        expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: "password-transition" } }))
            .toMatchObject({ revision: 3, credential });
    });

    it("refuses an envelope bound to another signing key before either persisted fact changes", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({ data: {
            id: "password-transition", encryptionMode: "plain", ...binding,
            AccountPasswordCredential: { create: { revision: 1, credential: sourceCredential } },
        } });
        await expect(inTx((tx) => applyAccountEncryptionTransitionInTx(tx, {
            accountId: "password-transition", expectedVersion: 0, toMode: "e2ee", contentKey: { kind: "preserve" },
            passwordCredential: { expectedRevision: 1, credential: targetCredential(createSignedAccountContentBinding().publicKey) },
        }))).rejects.toThrow();
        expect((await db.account.findUniqueOrThrow({ where: { id: "password-transition" } })).encryptionMode).toBe("plain");
        expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: "password-transition" } }))
            .toMatchObject({ revision: 1, credential: sourceCredential });
    });

    it("replaces an E2EE credential with the prepared Plain verifier in the mode transaction", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({ data: {
            id: "password-transition", encryptionMode: "e2ee", ...binding,
            AccountPasswordCredential: { create: { revision: 1, credential: targetCredential(binding.publicKey) } },
        } });
        expect(await inTx((tx) => applyAccountEncryptionTransitionInTx(tx, {
            accountId: "password-transition", expectedVersion: 0, toMode: "plain", contentKey: { kind: "preserve" },
            passwordCredential: { expectedRevision: 1, credential: sourceCredential },
        }))).toMatchObject({ mode: "plain" });
        expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: "password-transition" } }))
            .toMatchObject({ revision: 2, credential: sourceCredential });
    });

    it("refuses to consume a source E2EE credential bound to another Account signing key", async () => {
        const binding = createSignedAccountContentBinding();
        const inconsistentCredential = targetCredential(createSignedAccountContentBinding().publicKey);
        await db.account.create({ data: {
            id: "password-transition", encryptionMode: "e2ee", ...binding,
            AccountPasswordCredential: { create: { revision: 1, credential: inconsistentCredential } },
        } });

        await expect(inTx((tx) => applyAccountEncryptionTransitionInTx(tx, {
            accountId: "password-transition", expectedVersion: 0, toMode: "plain", contentKey: { kind: "preserve" },
            passwordCredential: { expectedRevision: 1, credential: sourceCredential },
        }))).rejects.toThrow("password_credential_inconsistent");

        expect(await db.account.findUniqueOrThrow({ where: { id: "password-transition" } }))
            .toMatchObject({ encryptionMode: "e2ee", publicKey: binding.publicKey });
        expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: "password-transition" } }))
            .toMatchObject({ revision: 1, credential: inconsistentCredential });
    });

    it("rolls back credential conversion with a later failure in the Account transaction", async () => {
        const binding = createSignedAccountContentBinding();
        await db.account.create({ data: {
            id: "password-transition", encryptionMode: "plain", ...binding,
            AccountPasswordCredential: { create: { revision: 1, credential: sourceCredential } },
        } });
        await expect(inTx(async (tx) => {
            await applyAccountEncryptionTransitionInTx(tx, {
                accountId: "password-transition", expectedVersion: 0, toMode: "e2ee", contentKey: { kind: "preserve" },
                passwordCredential: { expectedRevision: 1, credential: targetCredential(binding.publicKey) },
            });
            expect(await tx.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: "password-transition" } }))
                .toMatchObject({ revision: 2, credential: { kind: "e2ee_password_envelope" } });
            throw new Error("remaining Account mutation failed");
        })).rejects.toThrow("remaining Account mutation failed");
        expect((await db.account.findUniqueOrThrow({ where: { id: "password-transition" } })).encryptionMode).toBe("plain");
        expect(await db.accountPasswordCredential.findUniqueOrThrow({ where: { accountId: "password-transition" } }))
            .toMatchObject({ revision: 1, credential: sourceCredential });
    });
});
