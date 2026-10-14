import { decodeBase64 } from "privacy-kit";
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { SessionRecipientEnvelopeInputV1Schema, type SessionDataKeyEnvelopeErrorCodeV1 } from '@happier-dev/protocol/sessions/encryption/sessionDataKeyEnvelopes';

import type {
    AccountRecipientEnvelopeReadiness,
    AccountRecipientEnvelopeUnavailableReason,
} from "@/app/encryption/accountRecipientEnvelopeReadiness";

/**
 * What a direct access grant should do about the recipient's Session data key.
 *
 * Every outcome is an instruction to the surrounding grant transaction, never an
 * authorization: the caller has already proved actor authority and recipient
 * eligibility before asking. `grant_without_envelope` is a successful grant that
 * truthfully leaves the recipient in setup/repair, not a silent failure, and it
 * never fabricates a placeholder tuple.
 */
export type DirectSessionRecipientEnvelopeAdmission =
    | Readonly<{ outcome: "not_required" }>
    | Readonly<{ outcome: "write"; encryptedDataKey: string }>
    | Readonly<{ outcome: "reuse_existing" }>
    | Readonly<{ outcome: "grant_without_envelope"; reason: AccountRecipientEnvelopeUnavailableReason }>
    | Readonly<{ outcome: "rejected"; error: DirectSessionRecipientEnvelopeError }>;

export type DirectSessionRecipientEnvelopeError = Extract<
    SessionDataKeyEnvelopeErrorCodeV1,
    "invalid_request" | "data_key_not_required" | "recipient_envelope_required" | "recipient_key_unavailable"
>;

export type DirectSessionRecipientEnvelopeAdmissionParams = Readonly<{
    sessionEncryptionMode: "e2ee" | "plain";
    recipientReadiness: AccountRecipientEnvelopeReadiness;
    /** A structurally valid canonical tuple already exists for this recipient. */
    hasExistingEnvelope: boolean;
    /** The optional request field, still unparsed. Only `undefined` means omitted. */
    input: unknown;
}>;

/**
 * Decides the envelope half of one direct access grant.
 *
 * The three questions are answered in the order that keeps each answer truthful.
 * A Plain Session answers first, because recipient cryptography is meaningless
 * there and an explicit `data_key_not_required` is more useful than pretending
 * the supplied material was merely malformed. Omission is then separated from
 * malformed material so the client can tell "you forgot to seal a key" from
 * "what you sent is not a key". Recipient readiness decides last for supplied
 * material, because material sealed for an Account that cannot open anything is
 * rejected rather than stored as undeliverable bytes.
 *
 * The server cannot authenticate a sealed box, so admission here is structural
 * plus current readiness; whether the recipient can actually open the envelope
 * is proved by the recipient, not asserted by this decision.
 */
export function admitDirectSessionRecipientEnvelope(
    params: DirectSessionRecipientEnvelopeAdmissionParams,
): DirectSessionRecipientEnvelopeAdmission {
    const supplied = params.input !== undefined;

    if (params.sessionEncryptionMode === "plain") {
        return supplied
            ? { outcome: "rejected", error: "data_key_not_required" }
            : { outcome: "not_required" };
    }

    if (!supplied) {
        if (params.recipientReadiness.status === "unavailable") {
            return { outcome: "grant_without_envelope", reason: params.recipientReadiness.reason };
        }
        return params.hasExistingEnvelope
            ? { outcome: "reuse_existing" }
            : { outcome: "rejected", error: "recipient_envelope_required" };
    }

    // The wire schema proves the request is a canonical Base64 string of exactly
    // one envelope's length; the codec additionally proves the bytes carry the v1
    // version byte, so material no conforming producer could have emitted is
    // rejected here rather than stored as an unopenable tuple.
    const parsed = SessionRecipientEnvelopeInputV1Schema.safeParse(params.input);
    if (!parsed.success) return { outcome: "rejected", error: "invalid_request" };
    if (parseEncryptedDataKeyEnvelopeV1(decodeBase64(parsed.data.encryptedDataKey)) === null) {
        return { outcome: "rejected", error: "invalid_request" };
    }
    if (params.recipientReadiness.status === "unavailable") {
        return { outcome: "rejected", error: "recipient_key_unavailable" };
    }
    return { outcome: "write", encryptedDataKey: parsed.data.encryptedDataKey };
}
