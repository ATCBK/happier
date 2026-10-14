import { acceptPasswordTextV1, decodePasswordCredentialFieldV1, E2eeAccountPasswordCredentialV1Schema, PASSWORD_DERIVED_AUTH_KEY_BYTES_V1, PasswordWrappedRecoverySecretV1Schema, type E2eeAccountPasswordCredentialV1, type PasswordTextRejectionReasonV1, type PasswordWrappedRecoverySecretV1, type PlainAccountPasswordCredentialV1 } from '@happier-dev/protocol/auth/accountPasswordCredential';

import { hashPasswordMaterial, verifyPasswordMaterial } from './passwordMaterialVerifier';

type PasswordPreparationFailure = Readonly<{
    ok: false;
    reason: PasswordTextRejectionReasonV1 | 'invalid_auth_key' | 'invalid_envelope';
}>;

export async function preparePlainAccountPasswordCredentialV1(
    password: string,
): Promise<Readonly<{ ok: true; credential: PlainAccountPasswordCredentialV1 }> | PasswordPreparationFailure> {
    const accepted = acceptPasswordTextV1(password);
    if (!accepted.accepted) return { ok: false, reason: accepted.reason };
    return {
        ok: true,
        credential: {
            v: 1,
            kind: 'plain_password_hash',
            hash: await hashPasswordMaterial(accepted.utf8),
        },
    };
}

export async function prepareE2eeAccountPasswordCredentialV1(input: Readonly<{
    envelope: PasswordWrappedRecoverySecretV1;
    authKey: string;
}>): Promise<Readonly<{ ok: true; credential: E2eeAccountPasswordCredentialV1 }> | PasswordPreparationFailure> {
    const envelope = PasswordWrappedRecoverySecretV1Schema.safeParse(input.envelope);
    if (!envelope.success) return { ok: false, reason: 'invalid_envelope' };
    let authKey: Uint8Array;
    try {
        authKey = decodePasswordCredentialFieldV1(input.authKey);
    } catch {
        return { ok: false, reason: 'invalid_auth_key' };
    }
    if (authKey.byteLength !== PASSWORD_DERIVED_AUTH_KEY_BYTES_V1) {
        return { ok: false, reason: 'invalid_auth_key' };
    }
    const credential = {
        v: 1 as const,
        kind: 'e2ee_password_envelope' as const,
        envelope: envelope.data,
        authVerifier: { v: 1 as const, hash: await hashPasswordMaterial(authKey) },
    };
    const parsed = E2eeAccountPasswordCredentialV1Schema.safeParse(credential);
    return parsed.success
        ? { ok: true, credential: parsed.data }
        : { ok: false, reason: 'invalid_envelope' };
}

export async function verifyPlainAccountPasswordCredentialV1(
    credential: PlainAccountPasswordCredentialV1,
    password: string,
): Promise<boolean> {
    const accepted = acceptPasswordTextV1(password);
    return accepted.accepted && await verifyPasswordMaterial(credential.hash, accepted.utf8);
}
