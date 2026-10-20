import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol";
import * as bindingCrypto from "@happier-dev/protocol/crypto/accountContentKeyBindingV1";
import { describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import {
    admitAccountContentKey,
    deriveAccountEncryptionCurrentnessFromRow,
    verifyAccountContentKeyBinding,
} from "./accountContentKeyAdmission";

function createBinding() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();

    return {
        accountPublicKeyHex:
            Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySignature: new Uint8Array(
            signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey: content.publicKey,
            }),
        ),
    };
}

function createLowOrderBinding() {
    const signing = tweetnacl.sign.keyPair();
    const contentPublicKey = new Uint8Array(tweetnacl.box.publicKeyLength);
    // The canonical signer rejects this low-order key; raw signing exercises
    // admission of a correctly signed but unsafe persisted binding.
    const payload = Buffer.concat([
        Buffer.from("Happy content key v1\u0000", "utf8"),
        Buffer.from(contentPublicKey),
    ]);
    return {
        accountPublicKeyHex: Buffer.from(signing.publicKey).toString("hex"),
        contentPublicKey,
        contentPublicKeySignature: new Uint8Array(
            tweetnacl.sign.detached(payload, signing.secretKey),
        ),
    };
}

function createAccountClient(params: Readonly<{
    rows: ReadonlyArray<{
        publicKey: string;
        contentPublicKey: Uint8Array | null;
        contentPublicKeySig: Uint8Array | null;
    }>;
    updateCounts?: ReadonlyArray<number>;
}>) {
    const findUnique = vi.fn();
    for (const row of params.rows) {
        findUnique.mockResolvedValueOnce(row);
    }
    const updateMany = vi.fn();
    for (const count of params.updateCounts ?? []) {
        updateMany.mockResolvedValueOnce({ count });
    }
    // Narrow deterministic Prisma Account-delegate boundary fixture.
    const client = {
        $queryRawUnsafe: vi.fn(async () => [{ id: "account-1" }]),
        $executeRawUnsafe: vi.fn(async () => 1),
        account: {
            findUnique,
            updateMany,
        },
    } as unknown as Parameters<typeof admitAccountContentKey>[0];
    return { client, findUnique, updateMany };
}

describe("accountContentKeyAdmission", () => {
    it("reuses only the exact last verified public binding across fresh currentness derivations", () => {
        const binding = createBinding();
        // Transparent instrumentation: the real Protocol verifier and crypto run.
        const verify = vi.spyOn(bindingCrypto, "verifyAccountContentKeyBindingV1");
        try {
            for (let read = 0; read < 25; read += 1) {
                expect(deriveAccountEncryptionCurrentnessFromRow({
                    encryptionMode: "e2ee",
                    publicKey: binding.accountPublicKeyHex,
                    contentPublicKey: new Uint8Array(binding.contentPublicKey),
                    contentPublicKeySig: new Uint8Array(binding.contentPublicKeySignature),
                }).status).toBe("ready");
            }
            expect(verify).toHaveBeenCalledTimes(1);
            expect(deriveAccountEncryptionCurrentnessFromRow({
                encryptionMode: "unknown",
                publicKey: binding.accountPublicKeyHex,
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySig: binding.contentPublicKeySignature,
            })).toEqual({ status: "inconsistent", reason: "invalid_encryption_mode" });
            const plain = deriveAccountEncryptionCurrentnessFromRow({
                encryptionMode: "plain",
                publicKey: binding.accountPublicKeyHex,
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySig: binding.contentPublicKeySignature,
            });
            expect(plain.status === "ready" && plain.currentness.encryptionMode).toBe("plain");
        } finally {
            verify.mockRestore();
        }
    });

    it("does not lend verification to changed or mutated anchor, key, signature or returned bytes", () => {
        const binding = createBinding();
        const params = {
            accountSigningPublicKey: new Uint8Array(Buffer.from(binding.accountPublicKeyHex, "hex")),
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySignature: binding.contentPublicKeySignature,
        };
        for (const field of ["accountSigningPublicKey", "contentPublicKey", "contentPublicKeySignature"] as const) {
            expect(verifyAccountContentKeyBinding(params)).not.toBeNull();
            const changed = new Uint8Array(params[field]);
            changed[0] ^= 1;
            expect(verifyAccountContentKeyBinding({ ...params, [field]: changed })).toBeNull();
            params[field][0] ^= 1;
            expect(verifyAccountContentKeyBinding(params)).toBeNull();
            params[field][0] ^= 1;
        }
        const verified = verifyAccountContentKeyBinding(params);
        expect(verified).not.toBeNull();
        verified?.contentPublicKey.fill(0);
        verified?.contentPublicKeySignature.fill(0);
        const again = verifyAccountContentKeyBinding(params);
        expect(again?.contentPublicKey).toEqual(binding.contentPublicKey);
        expect(again?.contentPublicKeySignature).toEqual(binding.contentPublicKeySignature);
        expect(verifyAccountContentKeyBinding({
            ...params,
            contentPublicKeySignature: new Uint8Array(0),
        })).toBeNull();
    });

    it("rejects a correctly signed low-order content key before persistence", async () => {
        const binding = createLowOrderBinding();
        const client = createAccountClient({
            rows: [{
                publicKey: binding.accountPublicKeyHex,
                contentPublicKey: null,
                contentPublicKeySig: null,
            }],
        });

        await expect(admitAccountContentKey(client.client, {
            accountId: "account-1",
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySignature: binding.contentPublicKeySignature,
        })).resolves.toEqual({ status: "invalid_binding" });
        expect(client.updateMany).not.toHaveBeenCalled();
        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "e2ee",
            publicKey: binding.accountPublicKeyHex,
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: binding.contentPublicKeySignature,
        })).toEqual({
            status: "inconsistent",
            reason: "invalid_content_key_binding",
        });
    });

    it("refuses an exact key whose stored non-null signature is invalid", async () => {
        const binding = createBinding();
        const client = createAccountClient({
            rows: [{
                publicKey: binding.accountPublicKeyHex,
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySig: new Uint8Array(
                    tweetnacl.sign.signatureLength,
                ),
            }],
        });

        const result = await admitAccountContentKey(
            client.client,
            {
                accountId: "account-1",
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySignature:
                    binding.contentPublicKeySignature,
            },
        );

        expect(result).toEqual({ status: "invalid_binding" });
        expect(client.updateMany).not.toHaveBeenCalled();
    });

    it("refuses an invalid non-null signature observed after losing null initialization", async () => {
        const binding = createBinding();
        const client = createAccountClient({
            rows: [
                {
                    publicKey: binding.accountPublicKeyHex,
                    contentPublicKey: null,
                    contentPublicKeySig: null,
                },
                {
                    publicKey: binding.accountPublicKeyHex,
                    contentPublicKey: binding.contentPublicKey,
                    contentPublicKeySig: new Uint8Array(
                        tweetnacl.sign.signatureLength,
                    ),
                },
            ],
            updateCounts: [0],
        });

        const result = await admitAccountContentKey(
            client.client,
            {
                accountId: "account-1",
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySignature:
                    binding.contentPublicKeySignature,
            },
        );

        expect(result).toEqual({ status: "invalid_binding" });
        expect(client.findUnique).toHaveBeenCalledTimes(2);
    });

    it("reports an e2ee Account missing its signing key as inconsistent", () => {
        const binding = createBinding();

        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "e2ee",
            publicKey: null,
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: binding.contentPublicKeySignature,
        })).toEqual({
            status: "inconsistent",
            reason: "missing_or_invalid_signing_key",
        });
    });

    it("reports an e2ee Account missing its content-key binding as inconsistent", () => {
        const binding = createBinding();

        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "e2ee",
            publicKey: binding.accountPublicKeyHex,
            contentPublicKey: null,
            contentPublicKeySig: null,
        })).toEqual({
            status: "inconsistent",
            reason: "missing_content_key_binding",
        });
    });

    it("reports an e2ee Account with an invalid content-key binding as inconsistent", () => {
        const binding = createBinding();

        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "e2ee",
            publicKey: binding.accountPublicKeyHex,
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: new Uint8Array(tweetnacl.sign.signatureLength),
        })).toEqual({
            status: "inconsistent",
            reason: "invalid_content_key_binding",
        });
    });

    it("preserves normal plain and valid e2ee currentness", () => {
        const binding = createBinding();

        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "plain",
            publicKey: null,
            contentPublicKey: null,
            contentPublicKeySig: null,
        })).toEqual({
            status: "ready",
            currentness: {
                encryptionMode: "plain",
                contentPublicKey: null,
                contentPublicKeySignature: null,
                contentPublicKeyFingerprint: null,
            },
        });
        expect(deriveAccountEncryptionCurrentnessFromRow({
            encryptionMode: "e2ee",
            publicKey: binding.accountPublicKeyHex,
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: binding.contentPublicKeySignature,
        })).toEqual({
            status: "ready",
            currentness: {
                encryptionMode: "e2ee",
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySignature: binding.contentPublicKeySignature,
                contentPublicKeyFingerprint: expect.any(String),
            },
        });
    });
});
