import { beforeEach, describe, expect, it } from 'vitest';
import { log } from '@/log';

import {
  readSafeVoiceRuntimeFailureCode,
  readSafeVoiceRuntimeFailureDiagnosticReason,
  recordVoiceRuntimeFailure,
} from './voiceRuntimeFailureCode';
import { createVoiceTextTurnRejectedBeforeEffectError } from '@/voice/session/types';

describe('voiceRuntimeFailureCode', () => {
  beforeEach(() => {
    log.clear();
  });

  it.each(['agent_signed_out', 'VOICE_AGENT_TARGET_SESSION_UNSUPPORTED'])(
    'preserves the acquisition failure %s beneath definite pre-effect rejection', (code) => {
      const cause = Object.assign(new Error('private acquisition details'), { code });
      const rejection = createVoiceTextTurnRejectedBeforeEffectError(cause, 'provider_unavailable_before_acceptance');

      expect(rejection).toMatchObject({
        code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
        pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        cause,
      });
      expect(cause.code).toBe(code);
      expect(readSafeVoiceRuntimeFailureCode(rejection)).toBe(code);
    },
  );

  it('does not disclose arbitrary acquisition prose or unwrap an unrelated error family', () => {
    const cause = new Error('Bearer private-token for /Users/example/secret');
    const rejection = createVoiceTextTurnRejectedBeforeEffectError(cause, 'provider_unavailable_before_acceptance');
    expect(readSafeVoiceRuntimeFailureCode(rejection)).toBe('VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT');
    expect(readSafeVoiceRuntimeFailureCode(Object.assign(new Error('outer'), {
      code: 'another_error', cause: { code: 'agent_signed_out' },
    }))).toBe('another_error');
  });

  it('preserves cancellation identity for the existing Local Voice abort handler', () => {
    const cause = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const rejection = createVoiceTextTurnRejectedBeforeEffectError(cause, 'provider_unavailable_before_acceptance');
    expect(rejection.name).toBe('AbortError');
    expect(rejection.cause).toBe(cause);
  });

  it('distinguishes bounded metadata commit reasons without retaining arbitrary error data', () => {
    const refreshFailure = Object.assign(
      new Error('private refresh failure for /Users/example/secret'),
      {
        code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
        reason: 'session_refresh_failed',
        cause: { authorization: 'Bearer private-token' },
      },
    );
    const writeFailure = Object.assign(
      new Error('private metadata response body'),
      {
        code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
        reason: 'metadata_write_rejected',
        cause: { providerPayload: 'private-provider-payload' },
      },
    );

    for (const error of [refreshFailure, writeFailure]) {
      recordVoiceRuntimeFailure(
        'realtime_codex',
        'failed',
        'connection_failed',
        error.code,
        readSafeVoiceRuntimeFailureDiagnosticReason(error),
      );
    }

    const records = log.getLogs();
    expect(records).toHaveLength(2);
    expect(records[0]).toContain('"diagnosticReason":"session_refresh_failed"');
    expect(records[1]).toContain('"diagnosticReason":"metadata_write_rejected"');
    expect(records.join('\n')).not.toMatch(
      /private refresh failure|\/Users\/example\/secret|Bearer private-token|private metadata response body|private-provider-payload/,
    );
  });

  it.each([
    undefined,
    'unrecognized_private_reason',
    { nested: 'session_refresh_failed' },
  ])('uses unknown for an absent or unrecognized structural reason', (reason) => {
    expect(readSafeVoiceRuntimeFailureDiagnosticReason({
      code: 'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      reason,
    })).toBe('unknown');
  });

  it('does not accept a metadata reason from another error family', () => {
    expect(readSafeVoiceRuntimeFailureDiagnosticReason({
      code: 'ANOTHER_FAILURE',
      reason: 'session_refresh_failed',
    })).toBeUndefined();
  });

  it('normalizes an arbitrary recorder input without serializing it', () => {
    recordVoiceRuntimeFailure(
      'realtime_codex',
      'failed',
      'connection_failed',
      'VOICE_CONVERSATION_METADATA_COMMIT_FAILED',
      { privateReason: 'provider-secret-detail' },
    );

    const record = log.getLogs()[0];
    expect(record).toContain('"diagnosticReason":"unknown"');
    expect(record).not.toContain('provider-secret-detail');
  });
});
