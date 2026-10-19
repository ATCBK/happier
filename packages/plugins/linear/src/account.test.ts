import { describe, expect, it } from 'vitest';
import type { ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { linearConnectedAccountRuntime } from './account.js';
import { host } from './fixtures.test-support.js';

describe('Linear Connected Account', () => {
  it('requires reconnect after provider authentication refusal and keeps the personal key origin-bound', async () => {
    const h = host(() => ({}));
    h.request.mockResolvedValue({ status: 401, finalUrl: 'https://api.linear.app/graphql', headers: {}, body: new Uint8Array() });
    // Host-owned credential storage is the system boundary, never a plugin store.
    const context = { ...h.context, credentials: { get: async () => 'test-personal-key' } } as unknown as Parameters<ConnectedAccountRuntime['status']>[0];
    expect(await linearConnectedAccountRuntime.status(context)).toMatchObject({ status: 'reconnectRequired' });
    await expect(linearConnectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://other.example', headerNames: ['authorization'] }, context))
      .rejects.toThrow('linear/materializationUnsupported');
    expect(await linearConnectedAccountRuntime.materialize({ kind: 'httpHeaders', origin: 'https://api.linear.app', headerNames: ['authorization'] }, context))
      .toEqual({ kind: 'httpHeaders', headers: { authorization: 'test-personal-key' } });
  });
});
