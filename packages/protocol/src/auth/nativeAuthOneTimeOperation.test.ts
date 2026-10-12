import { describe, expect, it } from 'vitest';

import {
    createNativeAuthOneTimeOperationKeyV1,
    decodeNativeAuthOneTimeOperationV1,
    encodeNativeAuthOneTimeOperationV1,
    maskEmailForNativeAuthPreview,
    NATIVE_AUTH_EMAIL_VERIFY_TTL_MS,
    NATIVE_AUTH_PASSWORD_RESET_TTL_MS,
    NativeAuthOneTimeBearerV1Schema,
    type NativeAuthOneTimeOperationV1,
} from './nativeAuthOneTimeOperation.js';

const verify: NativeAuthOneTimeOperationV1 = {
    v: 1,
    purpose: 'verify_native_email',
    normalizedEmail: 'alice@example.com',
    consumer: { kind: 'fresh_account', continuationId: null },
};

const reset: NativeAuthOneTimeOperationV1 = {
    v: 1,
    purpose: 'reset_plain_password',
    accountId: 'acc_1',
    credentialRevision: 3,
    nativeIdentityId: 'identity_1',
    expectedNativeIdentity: 'alice@example.com',
};

const bearer = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('native auth one-time operation codec', () => {
    it('decodes retained operation annotations while leaving new operation encoding closed', () => {
        const annotated = { ...verify, retired: true, consumer: { ...verify.consumer, retired: true } };
        expect(decodeNativeAuthOneTimeOperationV1(JSON.stringify(annotated))).toEqual(verify);
        expect(() => encodeNativeAuthOneTimeOperationV1(annotated)).toThrow();
        expect(decodeNativeAuthOneTimeOperationV1(JSON.stringify({ ...annotated, normalizedEmail: 'Alice@Example.com' })))
            .toBeNull();
    });
    it('round-trips every closed verification consumer and password reset', () => {
        expect(decodeNativeAuthOneTimeOperationV1(encodeNativeAuthOneTimeOperationV1(verify))).toEqual(verify);
        for (const consumer of [
            { kind: 'password_enrollment', accountId: 'acc_1' },
            { kind: 'sign_in_email_change', accountId: 'acc_1', nativeIdentityId: 'identity_1', expectedNativeIdentity: 'old@example.com' },
            { kind: 'team_invitation', invitationId: 'invite_1', tokenHash: 'a'.repeat(64), teamId: 'team_1' },
        ] as const) {
            const operation: NativeAuthOneTimeOperationV1 = {
                v: 1, purpose: 'verify_native_email', normalizedEmail: 'alice@example.com', consumer,
            };
            expect(decodeNativeAuthOneTimeOperationV1(encodeNativeAuthOneTimeOperationV1(operation))).toEqual(operation);
        }
        expect(decodeNativeAuthOneTimeOperationV1(encodeNativeAuthOneTimeOperationV1(reset))).toEqual(reset);
    });

    it('rejects unknown purposes and denormalized email facts', () => {
        expect(decodeNativeAuthOneTimeOperationV1('{"v":1,"purpose":"verify_team_invitation"}')).toBeNull();
        expect(decodeNativeAuthOneTimeOperationV1(JSON.stringify({ ...verify, normalizedEmail: 'Alice@Example.com' }))).toBeNull();
        expect(decodeNativeAuthOneTimeOperationV1(JSON.stringify({ ...reset, credentialRevision: 0 }))).toBeNull();
        expect(decodeNativeAuthOneTimeOperationV1('not json')).toBeNull();
    });

    it('rejects password reset authority without the native identity lifetime', () => {
        const { nativeIdentityId: _nativeIdentityId, ...incomplete } = reset;
        expect(decodeNativeAuthOneTimeOperationV1(JSON.stringify(incomplete))).toBeNull();
    });

    it('never lets one purpose read another purpose bearer address', () => {
        const verifyKey = createNativeAuthOneTimeOperationKeyV1('verify_native_email', bearer);
        const resetKey = createNativeAuthOneTimeOperationKeyV1('reset_plain_password', bearer);
        expect(verifyKey.startsWith('auth_email_verify_v1:')).toBe(true);
        expect(resetKey.startsWith('auth_password_reset_v1:')).toBe(true);
        expect(verifyKey.slice('auth_email_verify_v1:'.length))
            .not.toBe(resetKey.slice('auth_password_reset_v1:'.length));
    });

    it('addresses the bearer only through a digest and never stores the raw bytes', () => {
        const key = createNativeAuthOneTimeOperationKeyV1('verify_native_email', bearer);
        expect(key).not.toContain(bearer);
        expect(key).toBe(createNativeAuthOneTimeOperationKeyV1('verify_native_email', bearer));
    });

    it('accepts only a canonical 32-byte base64url bearer', () => {
        expect(NativeAuthOneTimeBearerV1Schema.safeParse(bearer).success).toBe(true);
        expect(NativeAuthOneTimeBearerV1Schema.safeParse('short').success).toBe(false);
        expect(NativeAuthOneTimeBearerV1Schema.safeParse(`${bearer}=`).success).toBe(false);
        expect(NativeAuthOneTimeBearerV1Schema.safeParse(bearer.replace('A', '+')).success).toBe(false);
    });

    it('uses the code-owned V1 expiry defaults', () => {
        expect(NATIVE_AUTH_EMAIL_VERIFY_TTL_MS).toBe(24 * 60 * 60 * 1000);
        expect(NATIVE_AUTH_PASSWORD_RESET_TTL_MS).toBe(60 * 60 * 1000);
    });

    it('masks a preview destination without disclosing the full local part', () => {
        expect(maskEmailForNativeAuthPreview('alice@example.com')).toBe('a••••@example.com');
        expect(maskEmailForNativeAuthPreview('a@example.com')).toBe('•@example.com');
        expect(maskEmailForNativeAuthPreview('not-an-email')).toBeNull();
    });
});
