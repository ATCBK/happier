import {
    deriveAccountEncryptionCurrentnessFromRow,
    isAccountContentKeyBindingRecoveryRequired,
    type AccountEncryptionCurrentnessResult,
    type VerifiedAccountContentKeyBinding,
} from "@/app/encryption/accountContentKeyAdmission";

import type { AccountRecipientEnvelopeUnavailableReason } from '@happier-dev/protocol/account/encryptionMode';
export type { AccountRecipientEnvelopeUnavailableReason } from '@happier-dev/protocol/account/encryptionMode';

export type AccountRecipientEnvelopeReadiness =
    | Readonly<{
        status: "available";
        binding: VerifiedAccountContentKeyBinding;
    }>
    | Readonly<{
        status: "unavailable";
        reason: AccountRecipientEnvelopeUnavailableReason;
    }>;

export type AccountRecipientEnvelopeReadinessRow = Readonly<{
    publicKey: string | null;
    encryptionMode: string | null;
    contentPublicKey: Uint8Array | null;
    contentPublicKeySig: Uint8Array | null;
}>;

/**
 * Projects one Account row onto the question Session key delivery actually
 * asks: can a Session data key be sealed to this Account right now, and if
 * not, is the truthful reason keyless plain use, ordinary setup, or an
 * inconsistent binding that needs repair?
 *
 * Readiness is derived from the canonical Account encryption currentness
 * owner, never from key presence alone, and never adds a status to the
 * Account currentness union. Account status and resource access are checked
 * separately before this projection is disclosed.
 */
export function deriveAccountRecipientEnvelopeReadinessFromRow(
    account: AccountRecipientEnvelopeReadinessRow,
    currentness: AccountEncryptionCurrentnessResult =
        deriveAccountEncryptionCurrentnessFromRow(account),
): AccountRecipientEnvelopeReadiness {
    if (currentness.status === "ready") {
        if (currentness.currentness.encryptionMode === "plain") {
            // A retained binding on a plain Account is not recipient readiness.
            return { status: "unavailable", reason: "plain_account" };
        }
        const {
            contentPublicKey,
            contentPublicKeySignature,
            contentPublicKeyFingerprint,
        } = currentness.currentness;
        if (
            contentPublicKey === null
            || contentPublicKeySignature === null
            || contentPublicKeyFingerprint === null
        ) {
            return {
                status: "unavailable",
                reason: "encryption_inconsistent",
            };
        }
        return {
            status: "available",
            binding: {
                contentPublicKey,
                contentPublicKeySignature,
                contentPublicKeyFingerprint,
            },
        };
    }

    return isAccountContentKeyBindingRecoveryRequired(account, currentness)
        ? { status: "unavailable", reason: "encryption_setup_required" }
        : { status: "unavailable", reason: "encryption_inconsistent" };
}
