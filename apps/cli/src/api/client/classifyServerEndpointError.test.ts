import { describe, expect, it } from 'vitest';

import { classifyServerEndpointError, isProvenPreDispatchConnectionFailure, readNormalizedConnectionErrorCode } from './classifyServerEndpointError';
import { AccountEncryptionCurrentnessUnavailableError, fetchAccountEncryptionCurrentness } from './accountEncryptionCurrentness';

describe('classifyServerEndpointError', () => {
  it('classifies an unreachable host as retryable network failure, including a nested cause', () => {
    const error = Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' });
    expect(classifyServerEndpointError(error)).toMatchObject({ kind: 'network', retryable: true });
    expect(isProvenPreDispatchConnectionFailure({ cause: error })).toBe(true);
  });

  it('does not treat a reset connection as proof that a mutation was never dispatched', () => {
    expect(isProvenPreDispatchConnectionFailure({ code: 'ECONNRESET' })).toBe(false);
  });

  it('finds a nested code when a wrapper has only whitespace at its top level', () => {
    const error = { code: ' ', cause: { code: ' ehostunreach ' } };
    expect(readNormalizedConnectionErrorCode(error)).toBe('EHOSTUNREACH');
  });

  it.each([
    { failure: 'ECONNABORTED', kind: 'timeout', retryable: true },
    { failure: 'ECONNRESET', kind: 'network', retryable: true },
    { failure: 503, kind: 'server_error', retryable: true },
    { failure: 403, kind: 'auth_failed', retryable: false },
  ])('preserves the currentness read recovery disposition ($failure)', async ({ failure: input, kind, retryable }) => {
    const failure = await fetchAccountEncryptionCurrentness({ token: 'fixture',
      request: async () => {
        if (typeof input === 'number') return { status: input, data: {} };
        throw Object.assign(new Error('read failed'), { code: input });
      } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AccountEncryptionCurrentnessUnavailableError);
    expect(classifyServerEndpointError(failure)).toMatchObject({ kind, retryable });
  });

  it('keeps invalid currentness terminal', () => {
    expect(classifyServerEndpointError(new AccountEncryptionCurrentnessUnavailableError(
      'Account encryption currentness response is invalid'))).toEqual({ kind: 'protocol_error', retryable: false });
  });
});
