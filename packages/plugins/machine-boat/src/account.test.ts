import { describe, expect, it } from 'vitest';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime } from './account.js';

function context(status: number, code: string): ConnectedAccountReadContext {
  const value = status === 200
    ? { ok: true, type: 'limits.info', sandboxPlanDollars: 20, canStart: true, activeSandboxes: 0, maxActiveSandboxes: 100, billingStatus: 'active' }
    : { ok: false, type: 'sandbox.error', status, code, message: code, error: { code, message: code, status }, requestId: 'req_test' };
  return { signal: new AbortController().signal, configuration: { values: {} }, credentials: { get: async () => 'private-token' },
    services: { http: { request: async (request: { url: string }) => ({ status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) }) } },
  } as unknown as ConnectedAccountReadContext;
}

describe('Boat captured account health', () => {
  it('distinguishes rejected credentials from unavailable service', async () => {
    expect(await connectedAccountRuntime.status(context(401, 'unauthorized'))).toMatchObject({ status: 'reconnectRequired' });
    expect(await connectedAccountRuntime.status(context(503, 'http_500'))).toMatchObject({ status: 'unavailable' });
    expect(await connectedAccountRuntime.status(context(200, 'ok'))).toMatchObject({ status: 'connected', displayName: 'Boat' });
  });
});
