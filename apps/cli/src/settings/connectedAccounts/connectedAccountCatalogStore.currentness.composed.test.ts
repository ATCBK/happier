import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { sealConnectedAccountCatalogContentV1, type ConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createCliConnectedAccountCatalogStore } from './connectedAccountCatalogStore';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function catalogAuthorityFixture() {
  const channel = await createRequesterCurrentnessSocketHarness();
  const accountId = 'catalog-authority-account';
  const secret = new Uint8Array(32).fill(7);
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
    encryption: { type: 'legacy' as const, secret } };
  const material = credentials.encryption;
  const fingerprint = convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material }).contentPublicKeyFingerprint);
  let currentness: AccountEncryptionCurrentnessResponse = { mode: 'e2ee', version: 1,
    signingKeyFingerprint: 'signing-current', contentKeyFingerprint: fingerprint, updatedAt: 1 };
  const record: ConnectedAccountCatalogRecordV1 = { key: 'configurations', value: { v: 1, entries: [{
    service: { pluginId: 'happier.connected-account.test', localId: 'api' }, modeId: 'api-key', revision: 'configured',
    values: { endpoint: 'https://private.example.test' }, secretRefs: {},
  }] } };
  const row = { status: 'present', revision: 4, content: sealConnectedAccountCatalogContentV1({ mode: 'e2ee', material, record }) };
  let revoked = false;
  let reads = 0;
  let holdRow = false;
  const rowRequested = deferred();
  const releaseRow = deferred();
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/account/encryption/currentness') {
      reads++;
      response.statusCode = revoked ? 401 : 200;
      response.end(JSON.stringify(revoked ? { error: 'unauthorized' } : currentness));
    } else if (request.url === '/v1/account/entity-rows/connected-accounts/configurations') {
      if (holdRow) { rowRequested.resolve(); await releaseRow.promise; }
      response.end(JSON.stringify(row));
    } else { response.statusCode = 404; response.end(JSON.stringify({ error: 'unsupported' })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token: credentials.token, serverBaseUrl: base });
  const store = runWithServerHttpBaseUrl(base, () => {
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKey(credentials),
      settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [] });
    return createCliConnectedAccountCatalogStore({ credentials });
  });
  return {
    store, record, channel, rowRequested, releaseRow,
    warm: () => holder.read(),
    reads: () => reads,
    holdRow: () => { holdRow = true; },
    change(change: 'mode' | 'epoch') {
      if (change === 'epoch') revoked = true;
      else currentness = { mode: 'plain', version: 2, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 2 };
    },
    async close() {
      releaseRow.resolve();
      await holder.dispose();
      await channel.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

it('borrows warm catalog identity while freshly admitting each opened result', async () => {
  const f = await catalogAuthorityFixture();
  try {
    await f.warm();
    for (let read = 0; read < 2; read++) {
      await expect(f.store.readAdmittedCatalog('configurations')).resolves.toMatchObject({ status: 'ready', record: f.record });
    }
    // One socket warm-up plus exactly one final HTTP authority point per read.
    expect(f.reads()).toBe(3);
  } finally { await f.close(); }
});

it.each([
  ['mode', false], ['epoch', false], ['mode', true], ['epoch', true],
] as const)('withholds opened catalog after committed %s before socket delivery (gap=%s)', async (change, gap) => {
  const f = await catalogAuthorityFixture();
  try {
    await f.warm();
    f.holdRow();
    const read = f.store.readAdmittedCatalog('configurations');
    const settled = read.then(value => ({ value }), error => ({ error }));
    await f.rowRequested.promise;
    f.change(change);
    if (gap) await f.channel.disconnect();
    else expect(f.channel.clients.every(client => client.connected)).toBe(true);
    f.releaseRow.resolve();
    const result = await settled;
    if (change === 'mode') expect(result).toEqual({ value: { status: 'unavailable', reason: 'account-mode-mismatch' } });
    else expect(result).toMatchObject({ error: { code: 'account_encryption_currentness_unavailable' } });
  } finally { await f.close(); }
});

it.each(['mode', 'epoch'] as const)('refuses early ready publication after committed %s while the private response is held', async change => {
  const f = await catalogAuthorityFixture();
  try {
    await f.warm();
    f.holdRow();
    const published: unknown[] = [];
    const read = f.store.readCatalog('configurations', async catalog => { published.push(catalog); });
    const settled = read.then(value => ({ value }), error => ({ error }));
    await f.rowRequested.promise;
    f.change(change);
    expect(f.channel.clients.every(client => client.connected)).toBe(true);
    f.releaseRow.resolve();
    expect(await settled).toHaveProperty('error');
    expect(published).toEqual([]);
  } finally { await f.close(); }
});
