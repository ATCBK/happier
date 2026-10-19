import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { readAccountSessionDeliveryMutedScopes, readSessionDeliveryMutedScopes } from './sessionDeliveryMuteTransport';

describe('receiver delivery mute read transport', () => {
  it('reads the captured Account endpoint and treats malformed, unavailable and cancelled reads as unavailable', async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`;
    const captured = { accountId: 'account', token, serverHttpBaseUrl: 'https://target.example' };
    const scopes = [{ kind: 'source', source: { kind: 'session', sessionId: 'source' } }];
    const request = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { scopes } });
    try {
      expect(await readAccountSessionDeliveryMutedScopes(captured)).toEqual(scopes);
      expect(request).toHaveBeenCalledWith('https://target.example/v2/account/session-delivery-mutes',
        expect.objectContaining({ headers: { Authorization: `Bearer ${token}` } }));
      request.mockResolvedValue({ status: 200, data: { scopes: [], accountId: 'other' } });
      expect(await readAccountSessionDeliveryMutedScopes(captured)).toBeNull();
      request.mockResolvedValue({ status: 503, data: { error: 'mute_state_unavailable' } });
      expect(await readAccountSessionDeliveryMutedScopes(captured)).toBeNull();
      const cancellation = new AbortController();
      request.mockImplementationOnce(async () => {
        cancellation.abort();
        return { status: 200, data: { scopes } };
      });
      expect(await readAccountSessionDeliveryMutedScopes({ ...captured, signal: cancellation.signal })).toBeNull();
    } finally { request.mockRestore(); }
  });

  it('refuses another Account or an absent captured Home before disclosing its mute scopes', async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'actual-account' })).toString('base64url')}.signature`;
    const request = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { scopes: [] } });
    try {
      const captured = { receiver: { kind: 'account' as const }, token, serverHttpBaseUrl: 'https://target.example', accountId: 'different-account' };
      expect(await readSessionDeliveryMutedScopes(captured)).toBeNull();
      expect(await readSessionDeliveryMutedScopes({ ...captured, accountId: 'actual-account', serverHttpBaseUrl: '' })).toBeNull();
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });

  it('keeps Pending unavailable when captured-Home authorization throws before HTTP', async () => {
    const request = vi.spyOn(axios, 'get');
    try {
      const scopes = await readSessionDeliveryMutedScopes({
        receiver: { kind: 'session', sessionId: 'receiver' }, token: 'runtime-token',
        serverHttpBaseUrl: 'https://home.example',
        authorizeRequest: () => { throw new Error('captured_home_unavailable'); },
      });
      expect(scopes).toBeNull();
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  });
});
