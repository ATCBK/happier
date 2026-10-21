import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { runConnectedAccountBindingStage, withConnectedAccountBindingDiagnostic } from './bindingDiagnostics';

describe('Connected Account binding diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());

  it('omits arbitrary plugin error codes and values while retaining the exact failure', async () => {
    const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    const failure = Object.assign(new Error('private-error-message'), {
      code: 'private_credential_encoded_as_a_code', body: { password: 'private-body' },
    });
    await expect(withConnectedAccountBindingDiagnostic({ requestId: 'request-1', sessionId: 'session-1' }, () =>
      runConnectedAccountBindingStage('target_resolution', () => { throw failure; }))).rejects.toBe(failure);
    expect(log.mock.calls).toContainEqual(['[connected-account-binding-stage]', {
      requestId: 'request-1', sessionId: 'session-1', stage: 'target_resolution', event: 'failure',
      durationMs: expect.any(Number), errorCode: 'binding_read_failed',
    }]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/private[_-]/);
  });

  it('keeps both successful and failed reads unchanged when file logging fails', async () => {
    vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => { throw new Error('file unavailable'); });
    const failure = new Error('original operation failure');
    await withConnectedAccountBindingDiagnostic({ requestId: 'request-2' }, async () => {
      expect(await runConnectedAccountBindingStage('retained_binding', () => null)).toBeNull();
      await expect(runConnectedAccountBindingStage('account_purpose_read', () => { throw failure; })).rejects.toBe(failure);
    });
  });
});
