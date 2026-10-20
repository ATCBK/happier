import { describe, expect, it } from "vitest";
import { signAccountContentKeyBindingV1 } from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";

import {
    createAccountRecipientEnvelopeReadinessReadScope,
    deriveAccountRecipientEnvelopeReadinessFromRow,
} from "./accountRecipientEnvelopeReadiness";

type AccountRow = Readonly<{
    publicKey: string | null;
    encryptionMode: string | null;
    contentPublicKey: Uint8Array | null;
    contentPublicKeySig: Uint8Array | null;
}>;

function createSignedBinding() {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const contentPublicKey = new Uint8Array(content.publicKey);
    return {
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        signingSecretKey: signing.secretKey,
        contentPublicKey,
        contentPublicKeySig: signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey,
        }),
    };
}

function e2eeRow(overrides: Partial<AccountRow> = {}): AccountRow {
    const binding = createSignedBinding();
    return {
        publicKey: binding.publicKey,
        encryptionMode: "e2ee",
        contentPublicKey: binding.contentPublicKey,
        contentPublicKeySig: binding.contentPublicKeySig,
        ...overrides,
    };
}

describe("deriveAccountRecipientEnvelopeReadinessFromRow", () => {
    it("does not reuse a verified row after mode, signing key, content key or signature changes within a read", () => {
        const original = { id: "recipient", ...e2eeRow() };
        const read = createAccountRecipientEnvelopeReadinessReadScope();
        expect(read(original).status).toBe("available");
        expect(read({ ...original, encryptionMode: "plain" })).toEqual({ status: "unavailable", reason: "plain_account" });
        const other = createSignedBinding();
        for (const changed of [
            { ...original, publicKey: other.publicKey },
            { ...original, contentPublicKey: other.contentPublicKey },
            { ...original, contentPublicKeySig: other.contentPublicKeySig },
        ]) {
            expect(read(changed)).toEqual({ status: "unavailable", reason: "encryption_inconsistent" });
        }
        original.contentPublicKeySig?.fill(0);
        expect(read(original)).toEqual({ status: "unavailable", reason: "encryption_inconsistent" });
    });

    it("reports a healthy plain Account as keyless rather than a pending recipient", () => {
        expect(deriveAccountRecipientEnvelopeReadinessFromRow({
            publicKey: null,
            encryptionMode: "plain",
            contentPublicKey: null,
            contentPublicKeySig: null,
        })).toEqual({ status: "unavailable", reason: "plain_account" });
    });

    it("keeps a plain Account keyless even when it retains a valid content-key binding", () => {
        const binding = createSignedBinding();

        expect(deriveAccountRecipientEnvelopeReadinessFromRow({
            publicKey: binding.publicKey,
            encryptionMode: "plain",
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: binding.contentPublicKeySig,
        })).toEqual({ status: "unavailable", reason: "plain_account" });
    });

    it("exposes the validated binding for a complete E2EE Account", () => {
        const binding = createSignedBinding();

        const readiness = deriveAccountRecipientEnvelopeReadinessFromRow({
            publicKey: binding.publicKey,
            encryptionMode: "e2ee",
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: binding.contentPublicKeySig,
        });

        expect(readiness.status).toBe("available");
        if (readiness.status !== "available") return;
        expect(Array.from(readiness.binding.contentPublicKey))
            .toEqual(Array.from(binding.contentPublicKey));
        expect(Array.from(readiness.binding.contentPublicKeySignature))
            .toEqual(Array.from(binding.contentPublicKeySig));
        expect(readiness.binding.contentPublicKeyFingerprint)
            .toMatch(/^content-public-key-sha256:[0-9a-f]{64}$/u);
    });

    it("reports ordinary setup only when both binding fields are absent", () => {
        const binding = createSignedBinding();

        expect(deriveAccountRecipientEnvelopeReadinessFromRow({
            publicKey: binding.publicKey,
            encryptionMode: "e2ee",
            contentPublicKey: null,
            contentPublicKeySig: null,
        })).toEqual({
            status: "unavailable",
            reason: "encryption_setup_required",
        });
    });

    it("reports a partial binding as inconsistent, not repeatable setup", () => {
        const binding = createSignedBinding();

        expect(deriveAccountRecipientEnvelopeReadinessFromRow({
            publicKey: binding.publicKey,
            encryptionMode: "e2ee",
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: null,
        })).toEqual({
            status: "unavailable",
            reason: "encryption_inconsistent",
        });
        expect(deriveAccountRecipientEnvelopeReadinessFromRow({
            publicKey: binding.publicKey,
            encryptionMode: "e2ee",
            contentPublicKey: null,
            contentPublicKeySig: binding.contentPublicKeySig,
        })).toEqual({
            status: "unavailable",
            reason: "encryption_inconsistent",
        });
    });

    it("fails closed for a binding signed by a different Account signing key", () => {
        const other = createSignedBinding();

        expect(deriveAccountRecipientEnvelopeReadinessFromRow(e2eeRow({
            publicKey: other.publicKey,
        }))).toEqual({
            status: "unavailable",
            reason: "encryption_inconsistent",
        });
    });

    it("fails closed for a tampered content-key signature", () => {
        const binding = createSignedBinding();
        const tampered = new Uint8Array(binding.contentPublicKeySig);
        tampered[0] ^= 0xff;

        expect(deriveAccountRecipientEnvelopeReadinessFromRow({
            publicKey: binding.publicKey,
            encryptionMode: "e2ee",
            contentPublicKey: binding.contentPublicKey,
            contentPublicKeySig: tampered,
        })).toEqual({
            status: "unavailable",
            reason: "encryption_inconsistent",
        });
    });

    it("fails closed for a correctly signed low-order content public key", () => {
        const signing = tweetnacl.sign.keyPair();
        const lowOrderContentPublicKey = new Uint8Array(
            tweetnacl.box.publicKeyLength,
        );
        // The Protocol signer rejects this key, so the released binding bytes
        // are rebuilt here to prove the readiness projection also fails closed.
        const label = new TextEncoder().encode("Happy content key v1");
        const message = new Uint8Array(
            label.length + 1 + lowOrderContentPublicKey.length,
        );
        message.set(label, 0);
        message[label.length] = 0;
        message.set(lowOrderContentPublicKey, label.length + 1);

        expect(deriveAccountRecipientEnvelopeReadinessFromRow({
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            encryptionMode: "e2ee",
            contentPublicKey: lowOrderContentPublicKey,
            contentPublicKeySig: new Uint8Array(
                tweetnacl.sign.detached(message, signing.secretKey),
            ),
        })).toEqual({
            status: "unavailable",
            reason: "encryption_inconsistent",
        });
    });

    it("fails closed for a missing signing anchor and an unknown encryption mode", () => {
        expect(deriveAccountRecipientEnvelopeReadinessFromRow(e2eeRow({
            publicKey: null,
        }))).toEqual({
            status: "unavailable",
            reason: "encryption_inconsistent",
        });
        expect(deriveAccountRecipientEnvelopeReadinessFromRow(e2eeRow({
            encryptionMode: null,
        }))).toEqual({
            status: "unavailable",
            reason: "encryption_inconsistent",
        });
        expect(deriveAccountRecipientEnvelopeReadinessFromRow(e2eeRow({
            encryptionMode: "unknown_mode",
        }))).toEqual({
            status: "unavailable",
            reason: "encryption_inconsistent",
        });
    });
});
