import axios from 'axios';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { ApiClient } from './api';

describe('ApiClient route-grant refusals', () => {
  it.each([
    { reasonCode: 'machine_iroh_endpoint_unavailable', status: 200 },
    { reasonCode: 'machine_iroh_endpoint_mismatch', status: 403 },
    { reasonCode: 'grant_signing_unavailable', status: 200 },
  ])('preserves $reasonCode from HTTP $status as a typed peer refusal', async ({ reasonCode, status }) => {
    const response = { status, statusText: 'Forbidden', data: { ok: false, reasonCode,
      receipt: 'peer.route_grant.rejected' }, headers: {}, config: { headers: new axios.AxiosHeaders() } };
    const post = vi.spyOn(axios, 'post');
    if (status === 200) post.mockResolvedValue(response);
    else post.mockRejectedValue(new axios.AxiosError('HTTP refusal', 'ERR_BAD_REQUEST', response.config, undefined, response));
    onTestFinished(() => post.mockRestore());
    const api = await ApiClient.create({ token: 'test-token', encryption: null });
    await expect(api.mintPeerMediationRouteGrant({})).rejects.toMatchObject({
      code: 'peer_unavailable', reasonCode,
      message: `Peer mediation route grant is unavailable: ${reasonCode}`,
    });
  });

  it.each([{}, { ok: false, reasonCode: 'arbitrary response text' }])('keeps malformed refusals generic', async data => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data });
    onTestFinished(() => post.mockRestore());
    const api = await ApiClient.create({ token: 'test-token', encryption: null });
    await expect(api.mintPeerMediationRouteGrant({})).rejects.toMatchObject({
      code: 'peer_unavailable', message: 'Peer mediation route grant is unavailable',
    });
  });

  it('retains cancellation and network errors without converting their diagnostics', async () => {
    const failure = new axios.AxiosError('Connection reset', 'ECONNRESET');
    const post = vi.spyOn(axios, 'post').mockRejectedValue(failure);
    onTestFinished(() => post.mockRestore());
    const api = await ApiClient.create({ token: 'test-token', encryption: null });
    await expect(api.mintPeerMediationRouteGrant({})).rejects.toBe(failure);
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(api.mintPeerMediationRouteGrant({}, { signal: cancellation.signal })).rejects.toHaveProperty('name', 'AbortError');
  });
});
