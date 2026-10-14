import { encodeBase64 } from "privacy-kit";
import { type SessionDataKeyRecipientContentKeyV1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';

import {
    deriveAccountRecipientEnvelopeReadinessFromRow,
    type AccountRecipientEnvelopeReadiness,
} from "@/app/encryption/accountRecipientEnvelopeReadiness";

/**
 * The one wire projection of a recipient Account's content-key binding.
 *
 * Both envelope resources publish the same binding for the same purpose — the
 * per-Session collection publishes it per recipient, the membership-history
 * page publishes it once per page — so the readiness columns, their reason
 * vocabulary and their encodings live here rather than being answered twice.
 */

/** Account columns the recipient readiness owner reads; nothing else is disclosed. */
export const RECIPIENT_READINESS_SELECT = {
    id: true,
    publicKey: true,
    encryptionMode: true,
    contentPublicKey: true,
    contentPublicKeySig: true,
} as const;

export type RecipientReadinessRow = Readonly<{
    id: string;
    publicKey: string | null;
    encryptionMode: string | null;
    contentPublicKey: Uint8Array | null;
    contentPublicKeySig: Uint8Array | null;
}>;

export function projectRecipientContentKey(
    account: RecipientReadinessRow,
    readiness: AccountRecipientEnvelopeReadiness,
): SessionDataKeyRecipientContentKeyV1 {
    if (readiness.status === "unavailable") {
        return { status: "unavailable", reason: readiness.reason };
    }
    // Readiness is `available` only for a verified e2ee binding, which the
    // Account currentness owner reaches only after decoding this signing key.
    return {
        status: "available",
        accountSigningPublicKey: account.publicKey ?? "",
        contentPublicKey: encodeBase64(readiness.binding.contentPublicKey),
        contentPublicKeySignature: encodeBase64(readiness.binding.contentPublicKeySignature),
    };
}
