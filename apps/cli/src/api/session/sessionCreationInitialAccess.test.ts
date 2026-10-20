import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeFormatV1';
import { prepareSessionInitialAccessDataKeyEnvelopes } from './sessionCreationInitialAccess';

describe('Session envelope scope refusal', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it.each([
    { payload: { error: 'credential_scope_denied' }, code: 'credential_scope_denied' },
    { payload: { error: 'credential_scope_denied', details: {} }, code: 'not_authenticated' },
  ])('preserves only a strict scope refusal: $code', async ({ payload, code }) => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 403, data: payload });
    await expect(prepareSessionInitialAccessDataKeyEnvelopes({
      fields: { initialAccess: { grants: [{ subject: { kind: 'team', teamId: 'team' }, accessLevel: 'view', canApprovePermissions: false }] } },
      sessionId: 'same', sessionEncryptionMode: 'e2ee', resolveSessionDataKey: () => new Uint8Array(ENCRYPTED_DATA_KEY_V1_BYTES),
      token: 'token', serverHttpBaseUrl: 'http://envelopes.test',
    })).rejects.toMatchObject({ code, status: 403 });
  });
});
