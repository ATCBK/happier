import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { ConnectedServiceCredentialHttpClient } from '@/api/client/connectedServiceCredentialApi';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { resolveConnectedServiceAccountMode } from './resolveConnectedServiceAccountMode';

async function accountModeAuthorityFixture() {
  const channel = await createRequesterCurrentnessSocketHarness();
  const accountId = 'connected-service-mode-account';
  const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  let currentness: AccountEncryptionCurrentnessResponse = { mode: 'e2ee', version: 1,
    signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'content-current', updatedAt: 1 };
  let revoked = false;
  let reads = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/v1/account/encryption/currentness' && request.url !== '/v1/account/encryption') {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'unsupported' }));
      return;
    }
    reads++;
    response.statusCode = revoked ? 401 : 200;
    response.end(JSON.stringify(revoked ? { error: 'unauthorized' }
      : request.url === '/v1/account/encryption' ? { mode: currentness.mode, updatedAt: currentness.updatedAt } : currentness));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token, serverBaseUrl: base });
  const api = new ConnectedServiceCredentialHttpClient({ token });
  return {
    channel,
    warm: () => holder.read(),
    read: (options?: Readonly<{ refresh?: boolean; signal?: AbortSignal }>) => runWithServerHttpBaseUrl(base,
      () => resolveConnectedServiceAccountMode(api, options)),
    reads: () => reads,
    revoke: () => { revoked = true; },
    plain: () => {
      revoked = false;
      currentness = { mode: 'plain', version: 2, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 2 };
      return currentness;
    },
    async close() {
      await holder.dispose();
      await channel.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

describe('resolveConnectedServiceAccountMode canonical observation', () => {
  it('does not infer E2EE without an Account-mode owner', async () => {
    await expect(resolveConnectedServiceAccountMode({})).resolves.toBe('unknown');
    await expect(resolveConnectedServiceAccountMode({}, { refresh: true })).resolves.toBe('unknown');
  });

  it('preserves cancellation even when identity is warm', async () => {
    const f = await accountModeAuthorityFixture();
    try {
      await f.warm();
      const controller = new AbortController();
      controller.abort();
      await expect(f.read({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(f.reads()).toBe(1);
    } finally { await f.close(); }
  });

  it('borrows the exact warm owner without adding steady-state HTTP reads', async () => {
    const f = await accountModeAuthorityFixture();
    try {
      await f.warm();
      await expect(f.read()).resolves.toBe('e2ee');
      await expect(f.read()).resolves.toBe('e2ee');
      expect(f.reads()).toBe(1);
    } finally { await f.close(); }
  });

  it('immediately observes committed mode push instead of a second settled TTL value', async () => {
    const f = await accountModeAuthorityFixture();
    try {
      await f.warm();
      await expect(f.read()).resolves.toBe('e2ee');
      await f.channel.push('connected-service-mode-account', f.plain());
      await expect(f.read()).resolves.toBe('plain');
      expect(f.reads()).toBe(1);
    } finally { await f.close(); }
  });

  it.each(['mode', 'epoch'] as const)('does not retain identity after disconnect and %s change', async change => {
    const f = await accountModeAuthorityFixture();
    try {
      await f.warm();
      await expect(f.read()).resolves.toBe('e2ee');
      await f.channel.disconnect();
      if (change === 'mode') f.plain();
      else f.revoke();
      await expect(f.read()).resolves.toBe('unknown');
      expect(f.reads()).toBe(1);
      await f.channel.reconnect();
      await expect(f.read()).resolves.toBe(change === 'mode' ? 'plain' : 'unknown');
      expect(f.reads()).toBe(2);
    } finally { await f.close(); }
  });

  it('does not suppress explicit fresh authority after an earlier refusal', async () => {
    const f = await accountModeAuthorityFixture();
    try {
      await f.warm();
      f.revoke();
      await expect(f.read({ refresh: true })).resolves.toBe('unknown');
      f.plain();
      await expect(f.read({ refresh: true })).resolves.toBe('plain');
      expect(f.reads()).toBe(3);
    } finally { await f.close(); }
  });
});
