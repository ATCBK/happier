import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeSessionSubagentCustody } from './sessionSubagentCustodyHttp';

describe('Session custody authentication refusal', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it.each([
    { payload: { error: 'credential_scope_denied' }, code: 'credential_scope_denied' },
    { payload: { error: 'credential_scope_denied', details: {} }, code: 'not_authenticated' },
    { payload: { error: 'unknown_denial' }, code: 'not_authenticated' },
  ])('preserves only a strict scope refusal: $code', async ({ payload, code }) => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 403, data: payload });
    await expect(probeSessionSubagentCustody({ token: 'token', sessionId: 'same' }))
      .rejects.toMatchObject({ code });
  });
});
