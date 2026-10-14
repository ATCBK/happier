import { inspectTerminalProvisioningV3Payload, resolveTerminalProvisioningVariantV2, type TerminalProvisioningV2Response } from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import * as privacyKit from "privacy-kit";

import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";

const PROVISIONING_RESPONSE_MAX_BASE64_CHARACTERS = 512;

export type ProvisioningResponseKind = TerminalProvisioningV2Response["type"];

export type ProvisioningResponsePolicyResult =
    | Readonly<{ status: "accepted"; kind: ProvisioningResponseKind }>
    | Readonly<{
        status: "rejected";
        reason:
            | "invalid_provisioning_response"
            | "provisioning_kind_mismatch"
            | "provisioning_material_unavailable";
    }>;

/**
 * Server admission for an approver-supplied terminal-v3 response.
 *
 * The protocol owner identifies only the public outer variant. It deliberately makes no MAC or
 * private-key validity claim: the requester, which alone holds the QR binding secret and box key,
 * authenticates and opens the response. The server supplies the authoritative persisted Account
 * mode/currentness decision and never derives or inspects private Account key material.
 */
export function evaluateProvisioningResponsePolicy(input: Readonly<{
    account: Readonly<{
        publicKey: string | null;
        encryptionMode: string | null;
        contentPublicKey: Uint8Array | null;
        contentPublicKeySig: Uint8Array | null;
    }>;
    responseBase64: string;
    responseKind: ProvisioningResponseKind;
}>): ProvisioningResponsePolicyResult {
    if (
        input.responseBase64.length === 0
        || input.responseBase64.length > PROVISIONING_RESPONSE_MAX_BASE64_CHARACTERS
    ) {
        return { status: "rejected", reason: "invalid_provisioning_response" };
    }

    let payload: Uint8Array<ArrayBuffer>;
    try {
        payload = privacyKit.decodeBase64(input.responseBase64);
    } catch {
        return { status: "rejected", reason: "invalid_provisioning_response" };
    }
    if (privacyKit.encodeBase64(payload) !== input.responseBase64) {
        return { status: "rejected", reason: "invalid_provisioning_response" };
    }
    const inspected = inspectTerminalProvisioningV3Payload(payload);
    if (!inspected) {
        return { status: "rejected", reason: "invalid_provisioning_response" };
    }
    if (inspected.type !== input.responseKind) {
        return { status: "rejected", reason: "provisioning_kind_mismatch" };
    }

    const currentness = deriveAccountEncryptionCurrentnessFromRow(input.account);
    if (currentness.status !== "ready") {
        return { status: "rejected", reason: "provisioning_material_unavailable" };
    }
    const expected = resolveTerminalProvisioningVariantV2({
        encryptionMode: currentness.currentness.encryptionMode,
    });
    if (expected !== inspected.type) {
        return { status: "rejected", reason: "provisioning_kind_mismatch" };
    }
    return { status: "accepted", kind: inspected.type };
}
