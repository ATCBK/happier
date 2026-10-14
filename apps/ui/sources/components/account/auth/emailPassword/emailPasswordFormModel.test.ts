import { describe, expect, it } from 'vitest';

import { HappyError } from '@/utils/errors/errors';

import {
    createEmailPasswordDraft,
    describeEmailPasswordFailure,
    validateEmailPasswordDraft,
} from './emailPasswordFormModel';

const GOOD_PASSWORD = 'a calm sixteen plus password';

describe('native email/password draft validation', () => {
    it('accepts an exact non-ASCII password and returns the canonical normalized address', () => {
        const result = validateEmailPasswordDraft({
            purpose: 'login',
            draft: { ...createEmailPasswordDraft('  Person@Example.TEST '), password: '  exact é password 🔑  ' },
        });

        expect(result).toEqual({
            ok: true,
            normalizedEmail: 'person@example.test',
            email: 'Person@Example.TEST',
            password: '  exact é password 🔑  ',
        });
    });

    it('reports the first invalid field so the surface can focus it', () => {
        expect(validateEmailPasswordDraft({ purpose: 'login', draft: createEmailPasswordDraft('') }))
            .toEqual({ ok: false, problem: { field: 'email', messageKey: 'settingsAccount.nativePassword.emailRequired' } });
        expect(validateEmailPasswordDraft({ purpose: 'login', draft: createEmailPasswordDraft('not-an-address') }))
            .toEqual({ ok: false, problem: { field: 'email', messageKey: 'settingsAccount.nativePassword.emailInvalid' } });
        expect(validateEmailPasswordDraft({
            purpose: 'login',
            draft: { ...createEmailPasswordDraft('person@example.test'), password: 'short' },
        })).toEqual({ ok: false, problem: { field: 'password', messageKey: 'settingsAccount.nativePassword.passwordRequirements' } });
    });

    it('confirms the new password for creation but never for login', () => {
        const draft = {
            ...createEmailPasswordDraft('person@example.test'),
            password: GOOD_PASSWORD,
            confirmPassword: 'a different sixteen plus password',
        };

        expect(validateEmailPasswordDraft({ purpose: 'provision', draft }))
            .toEqual({ ok: false, problem: { field: 'confirmPassword', messageKey: 'settingsAccount.nativePassword.passwordMismatch' } });
        expect(validateEmailPasswordDraft({ purpose: 'login', draft }).ok).toBe(true);
    });

    it('requires the current password only when the mutation owner asks for it', () => {
        const draft = { ...createEmailPasswordDraft(), password: GOOD_PASSWORD, confirmPassword: GOOD_PASSWORD };

        expect(validateEmailPasswordDraft({ purpose: 'change', draft, requiresCurrentPassword: true }))
            .toEqual({ ok: false, problem: { field: 'currentPassword', messageKey: 'settingsAccount.nativePassword.currentPasswordRequired' } });
        expect(validateEmailPasswordDraft({ purpose: 'change', draft }).ok).toBe(true);
    });
});

describe('native email/password failure copy', () => {
    it('presents an E2EE mutation proof refusal as Account verification rather than a wrong new password', () => {
        const failure = new HappyError('refused', false, { kind: 'auth', status: 401, code: 'authentication_failed' });
        expect(describeEmailPasswordFailure(failure, { credentialField: 'accountKey' })).toEqual({
            field: 'form', messageKey: 'settingsAccount.nativePassword.accountVerificationFailed',
        });
        expect(describeEmailPasswordFailure(failure, { credentialField: 'currentPassword' }).field).toBe('currentPassword');
    });
    it('keeps unknown addresses and wrong passwords indistinguishable', () => {
        const wrongPassword = new HappyError('x', false, { kind: 'auth', status: 401, code: 'authentication_failed' });
        const unknownAddress = new HappyError('x', false, { kind: 'auth', status: 401, code: 'authentication_failed' });

        expect(describeEmailPasswordFailure(wrongPassword))
            .toEqual(describeEmailPasswordFailure(unknownAddress));
        expect(describeEmailPasswordFailure(wrongPassword).messageKey).toBe('settingsAccount.nativePassword.signInFailed');
    });

    it('never blames the credentials for a failure the credentials did not cause', () => {
        const unreachable = [
            new HappyError('x', true, { code: 'server_unreachable' }),
            new HappyError('x', true, { kind: 'network' }),
        ];
        for (const error of unreachable) {
            expect(describeEmailPasswordFailure(error)).toEqual({
                field: 'form', messageKey: 'settingsAccount.nativePassword.homeUnreachable',
            });
        }
        // An unrecognised failure is not a credential verdict: only `authentication_failed` is.
        const unknown = describeEmailPasswordFailure(new HappyError('x', true, { kind: 'auth', code: 'action_failed' }));
        expect(unknown.field).toBe('form');
        expect(unknown.messageKey).not.toBe('settingsAccount.nativePassword.signInFailed');
    });

    it('names the Home for a proven disabled Account and separates unavailable from rate limited', () => {
        expect(describeEmailPasswordFailure(
            new HappyError('x', false, { kind: 'auth', status: 403, code: 'account-disabled' }),
            { homeLabel: 'Studio' },
        )).toEqual({ field: 'form', messageKey: 'settingsAccount.nativePassword.accountDisabled', params: { home: 'Studio' } });

        expect(describeEmailPasswordFailure(new HappyError('x', false, { status: 403, code: 'method_not_available' })).messageKey)
            .toBe('settingsAccount.nativePassword.unavailable');
        expect(describeEmailPasswordFailure(new HappyError('x', false, { code: 'password-enrollment-external-auth-unavailable' })).messageKey)
            .toBe('settingsAccount.nativePassword.unavailable');
        expect(describeEmailPasswordFailure(new HappyError('x', false, { code: 'password-enrollment-external-auth-invalid' })).messageKey)
            .toBe('settingsAccount.nativePassword.linkExpired');
        expect(describeEmailPasswordFailure(new HappyError('x', true, { status: 429 })).messageKey)
            .toBe('settingsAccount.nativePassword.rateLimited');
        expect(describeEmailPasswordFailure(new HappyError('x', true, { status: 503, kind: 'server' })).messageKey)
            .toBe('settingsAccount.nativePassword.serverUnavailable');
        expect(describeEmailPasswordFailure(
            new HappyError('x', false, { status: 404, code: 'client_update_required' }),
            { homeLabel: 'Studio' },
        )).toEqual({
            field: 'form',
            messageKey: 'welcome.serverIncompatibleBody',
            params: { serverUrl: 'Studio' },
        });
    });

    it('treats a transport failure and an explicit cancellation as their own states', () => {
        const aborted = new Error('cancelled');
        aborted.name = 'AbortError';

        expect(describeEmailPasswordFailure(aborted).messageKey).toBe('settingsAccount.nativePassword.cancelled');
        expect(describeEmailPasswordFailure(new TypeError('Failed to fetch')).messageKey).toBe('settingsAccount.nativePassword.offline');
    });

    it('keeps Action approval and credential-race failures typed for recovery', () => {
        expect(describeEmailPasswordFailure(new HappyError('declined', false, { code: 'approval_rejected' })).messageKey)
            .toBe('settingsAccount.nativePassword.cancelled');
        expect(describeEmailPasswordFailure(new HappyError('stale', false, { code: 'identity_changed' })).messageKey)
            .toBe('settingsAccount.nativePassword.revisionConflict');
        expect(describeEmailPasswordFailure(new HappyError('last method', false, { code: 'last_login_method' })).messageKey)
            .toBe('settingsAccount.nativePassword.removePasswordConsequence');
        expect(describeEmailPasswordFailure(new HappyError('pending', false, { code: 'approval_pending' })).messageKey)
            .toBe('settingsAccount.nativePassword.approvalPending');
        expect(describeEmailPasswordFailure(new HappyError('wrong origin', false, { code: 'approval_binding_mismatch' })).messageKey)
            .toBe('settingsAccount.nativePassword.linkExpired');
        // A generic failure says the Home did not complete it; "unavailable" is reserved for the explicit reason.
        expect(describeEmailPasswordFailure(new HappyError('local settlement failed', false, { code: 'operation_failed' })))
            .toEqual({ field: 'form', messageKey: 'settingsAccount.nativePassword.serverUnavailable' });
        expect(describeEmailPasswordFailure(
            new HappyError('wrong current password', false, { code: 'authentication_failed' }),
            { credentialField: 'currentPassword' },
        ).field).toBe('currentPassword');
        expect(describeEmailPasswordFailure(new HappyError('challenge down', false, { code: 'challenge_unavailable' })).messageKey)
            .toBe('settingsAccount.nativePassword.serverUnavailable');
        expect(describeEmailPasswordFailure(new HappyError('inconsistent', false, { code: 'credential_inconsistent' })).messageKey)
            .toBe('settingsAccount.nativePassword.revisionConflict');
    });
});
