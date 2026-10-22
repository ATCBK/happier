import { describe, expect, it } from 'vitest';

import { MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';
import { classifyTransferFailure } from './transferFailureCode';

describe('classifyTransferFailure', () => {
    it.each([
        ['a Machine that stopped answering', { errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE }, 'unreachable'],
        ['a Home that cannot be reached', { errorCode: 'home_unreachable' }, 'unreachable'],
        ['no eligible transfer carrier', { errorCode: 'machine_carrier_unavailable' }, 'carrierUnavailable'],
        ['a selected carrier interrupted during transfer', { errorCode: 'machine_carrier_transport_failed' }, 'carrierInterrupted'],
        ['a thrown carrier interruption', { thrown: Object.assign(new Error('transport failed'), { errorCode: 'machine_carrier_transport_failed' }) }, 'carrierInterrupted'],
        ['a transport deadline nothing the person did caused', { thrown: new DOMException('signal timed out', 'TimeoutError') }, 'unreachable'],
        ['an approval the person cancelled', { errorCode: 'approval_canceled' }, 'declined'],
        ['an approval that was rejected', { errorCode: 'approval_rejected' }, 'declined'],
        ['a refused permission', { errorCode: 'credential_scope_denied' }, 'permission'],
        ['an operating-system permission', { errorCode: 'EACCES' }, 'permission'],
        ['a request over the size the Machine takes', { errorCode: 'request_too_large' }, 'tooLarge'],
        ['an acknowledgement that never arrived', { errorCode: 'outcome_uncertain' }, 'unconfirmed'],
        ['a finalize the Machine may have committed', { errorCode: 'DIRECT_IMPORT_FINALIZE_OUTCOME_INDETERMINATE' }, 'unconfirmed'],
        ['a code this does not name', { errorCode: 'direct_import_prepare_invalid' }, 'other'],
        ['a failure with no code at all', {}, 'other'],
    ] as const)('words %s', (_name, failure, reason) => {
        expect(classifyTransferFailure(failure)).toBe(reason);
    });
});
