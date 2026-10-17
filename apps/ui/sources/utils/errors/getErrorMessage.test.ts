import { describe, it, expect } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { HappyError } from './errors';
import { installErrorUtilityCommonModuleMocks } from './errorUtilityTestHelpers';

installErrorUtilityCommonModuleMocks();

const { getErrorMessage } = await import('./getErrorMessage');

describe('getErrorMessage', () => {
    it('localizes Action refusal and pending approval without replacing a supplied refusal message', () => {
        expect(getErrorMessage(new HappyError('action_disabled', false, { code: 'action_disabled' }))).toBe('common.disabled');
        expect(getErrorMessage(new HappyError('approval_request_created', false, { code: 'approval_request_created' }))).toBe('approvals.status.open');
        expect(getErrorMessage(new HappyError('invalid_parameters', false, { code: 'invalid_parameters' }))).toBe('common.requestFailed');
        expect(getErrorMessage(new HappyError('Choose a mode offered by this Agent', false, { code: 'invalid_parameters' })))
            .toBe('Choose a mode offered by this Agent');
        expect(getErrorMessage(new HappyError('This token cannot send to this session', false, { code: 'session_input_unauthorized' })))
            .toBe('This token cannot send to this session');
    });

    it('returns message for Error', () => {
        expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });

    it('falls back to String(error) when Error has empty message', () => {
        expect(getErrorMessage(new Error(''))).toBe('Error');
    });

    it('returns message field for plain object', () => {
        expect(getErrorMessage({ message: 'nope' })).toBe('nope');
    });

    it('returns string input as-is', () => {
        expect(getErrorMessage('oops')).toBe('oops');
    });

    it('explains unavailable Account encryption verification without displaying its machine code', () => {
        expect(getErrorMessage('account_encryption_currentness_unavailable'))
            .toBe('settingsAccount.encryptionFactUnread');
        expect(getErrorMessage(new HappyError('account_encryption_currentness_unavailable', false, {
            code: 'account_encryption_currentness_unavailable',
        }))).toBe('settingsAccount.encryptionFactUnread');
    });

    it('handles nullish values', () => {
        expect(getErrorMessage(null)).toBe('');
        expect(getErrorMessage(undefined)).toBe('');
    });

    it('says what a connected-account catalog failure means instead of its code', async () => {
        const { ConnectedAccountCatalogOperationError } = await import('@/sync/api/account/connectedAccountCatalogOperationError');
        expect(getErrorMessage(new ConnectedAccountCatalogOperationError('connected_account_purpose_catalog_unavailable')))
            .toBe('errors.connectedAccountsUnavailable');
        expect(getErrorMessage(new ConnectedAccountCatalogOperationError('unauthorized'))).toBe('errors.connectedAccountsUnavailable');
    });

    it('returns a daemon-unavailable message when rpc method is not available', () => {
        const err = new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        expect(getErrorMessage(err)).toBe('errors.daemonUnavailableBody');
    });
});
