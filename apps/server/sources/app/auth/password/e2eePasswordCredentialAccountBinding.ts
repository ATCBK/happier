import { decodePasswordCredentialFieldV1, type E2eeAccountPasswordCredentialV1, type PasswordWrappedRecoverySecretV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';
import * as privacyKit from "privacy-kit";

/** An E2EE password envelope must wrap the secret for its owning Account identity. */
export function isE2eePasswordEnvelopeBoundToAccount(
    envelope: PasswordWrappedRecoverySecretV1,
    accountPublicKey: string | null,
): boolean {
    if (!accountPublicKey) return false;
    return privacyKit.encodeHex(new Uint8Array(decodePasswordCredentialFieldV1(
        envelope.accountSigningPublicKey,
    ))).toLowerCase() === accountPublicKey.toLowerCase();
}

export function isE2eePasswordCredentialBoundToAccount(
    credential: E2eeAccountPasswordCredentialV1,
    accountPublicKey: string | null,
): boolean {
    return isE2eePasswordEnvelopeBoundToAccount(credential.envelope, accountPublicKey);
}
