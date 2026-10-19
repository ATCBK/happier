import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import * as sessionsHttp from './sessionsHttp';

vi.mock('axios', () => ({ default: { post: vi.fn(), put: vi.fn() } }));

describe('manager HTTP mutation', () => {
  it('preserves scope refusals for the specialized organization writers', async () => {
    vi.mocked(axios.put).mockResolvedValue({ status: 403, data: { error: 'credential_scope_denied' } });
    const denial = { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
    await expect(sessionsHttp.setSessionOrganizationPin({ token: 'token', sessionId: 'same', request: { pinned: false } }))
      .resolves.toEqual(denial);
    await expect(sessionsHttp.setSessionAttentionStanding({ token: 'token', sessionId: 'same', request: { standing: null } }))
      .resolves.toEqual(denial);
  });
  it('preserves the strict credential scope refusal before domain decoding', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 403, data: { error: 'credential_scope_denied' } });
    await expect(sessionsHttp.setSessionManager({ token: 'token', sessionId: 'worker', managerSessionId: 'lead', expectedManagerSessionId: null }))
      .resolves.toEqual({ ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' });
  });
  it.each([
    { error: 'credential_scope_denied', details: { sessionId: 'private' } },
    { error: 'unknown_denial' },
  ])('keeps malformed or unknown 403s closed', async (data) => {
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 403, data });
    await expect(sessionsHttp.setSessionManager({ token: 'token', sessionId: 'worker', managerSessionId: 'lead', expectedManagerSessionId: null }))
      .rejects.toMatchObject({ response: { status: 403 } });
  });
  it.each([
    { status: 409, result: { ok: false, error: 'manager_cas_conflict' } },
    { status: 400, result: { ok: false, error: 'manager_cycle' } },
    { status: 403, result: { ok: false, error: 'manager_forbidden', reason: 'pairwise' } },
  ])('preserves the closed typed refusal from HTTP $status', async ({ status, result }) => {
    vi.mocked(axios.post).mockResolvedValueOnce({ status, data: result });
    await expect(sessionsHttp.setSessionManager({
      token: 'token', sessionId: 'worker/a', managerSessionId: 'lead', expectedManagerSessionId: null,
    })).resolves.toEqual(result);
    expect(axios.post).toHaveBeenLastCalledWith(expect.stringContaining('/v1/sessions/worker%2Fa/manager'), {
      managerSessionId: 'lead', expectedManagerSessionId: null,
    }, expect.objectContaining({ validateStatus: expect.any(Function) }));
  });

  it('rejects a success for the wrong child or lead instead of accepting a mismatched attachment', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ status: 200, data: {
      ok: true, sessionId: 'worker', managerSessionId: 'wrong-lead', attachedAt: 1,
    } });
    await expect(sessionsHttp.setSessionManager({ token: 'token', sessionId: 'worker', managerSessionId: 'lead', expectedManagerSessionId: null }))
      .rejects.toThrow();
  });
});
