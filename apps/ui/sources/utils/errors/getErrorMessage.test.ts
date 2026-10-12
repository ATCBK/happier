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
