import fastify from 'fastify';
import { expect, it, onTestFinished } from 'vitest';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { acquireRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createCredentialedAccountArtifactStore } from './accountArtifactStore';

async function fixture(initialMode: 'plain' | 'e2ee' = 'plain') {
  const app = fastify();
  const channel = await createRequesterCurrentnessSocketHarness();
  const accountId = 'artifact-sealing-owner';
  const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  let mode = initialMode;
  let revoked = false;
  let modeReads = 0;
  let identityReads = 0;
  let writes = 0;
  app.addHook('onRequest', async request => { if (request.method === 'POST') writes++; });
  let afterHistory = () => {};
  const credentials = { token, encryption: initialMode === 'plain' ? null
    : { type: 'legacy' as const, secret: new Uint8Array(32).fill(17) } };
  const resource = await createResourceDataKey({ credentials, mode: initialMode });
  const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
    : encodeBase64(encryptWithDataKey(value, resource.dataKey));
  const header = { kind: 'example.v1', title: 'Private document' };
  const stored = { id: 'document', ownerAccountId: accountId, access: 'owner', encryptionMode: initialMode,
    header: encode(header), body: encode({ body: 'original' }),
    dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey, headerVersion: 1, bodyVersion: 1,
    seq: 1, createdAt: 1, updatedAt: 1 };
  app.get('/v1/account/encryption/currentness', async () => {
    identityReads++;
    return createAccountEncryptionCurrentnessFixture({ mode });
  });
  app.get('/v1/account/encryption', async (_request, reply) => {
    modeReads++;
    return revoked ? reply.code(401).send({ error: 'unauthorized' }) : { mode, updatedAt: 1 };
  });
  app.get('/v1/artifacts/document', async () => stored);
  app.get('/v1/artifacts/document/revisions', async () => {
    afterHistory();
    return { revisions: [{ bodyVersion: 1, body: stored.body, createdAt: 1, sizeBytes: stored.body.length }], retentionCount: 10 };
  });
  app.post('/v1/artifacts', async request => {
    const body = request.body as { id: string };
    return { id: body.id, headerVersion: 1, bodyVersion: 1 };
  });
  app.post('/v1/artifacts/document', async () => ({ success: true, headerVersion: 2, bodyVersion: 2 }));
  app.post('/v1/artifacts/document/revisions/1/restore', async () => ({ success: true, headerVersion: 2, bodyVersion: 2 }));
  const serverBaseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const holder = acquireRequesterAccountEncryptionCurrentness({ accountId, token, serverBaseUrl });
  onTestFinished(async () => { await holder.dispose(); await channel.close(); await app.close(); });
  await holder.read();
  const store = createCredentialedAccountArtifactStore(credentials);
  return {
    store, stored, header, serverBaseUrl, channel,
    run: <T>(action: () => T) => runWithServerHttpBaseUrl(serverBaseUrl, action),
    change(change: 'mode' | 'epoch') { if (change === 'mode') mode = initialMode === 'plain' ? 'e2ee' : 'plain'; else revoked = true; },
    afterHistory(action: () => void) { afterHistory = action; },
    counts: () => ({ modeReads, identityReads, writes }),
  };
}

it('keeps ordinary Artifact opening on the connected observed identity', async () => {
  const f = await fixture();
  for (let i = 0; i < 2; i++) await expect(f.run(() => f.store.read('document'))).resolves.toMatchObject({ body: 'original' });
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 0, writes: 0 });
});

it('withholds encrypted Artifact bytes and independent provenance after a late plain-mode commit', async () => {
  const f = await fixture('e2ee');
  let admissions = 0;
  const result: unknown = await f.run(() => f.store.create({ artifactId: 'document', header: f.header,
    binary: { bytes: new Uint8Array([1, 2, 3]), mime: 'application/octet-stream' },
    beforeWrite: async () => { if (++admissions === 2) f.change('mode'); },
  })).catch((error: unknown) => error);
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 1, writes: 0 });
  expect(result).toMatchObject({ code: 'artifact_account_mode_mismatch' });
});

it.each(['create', 'update', 'restore'] as const)('freshly refuses Artifact %s after mode commit before socket delivery', async operation => {
  const f = await fixture();
  let admissions = 0;
  const beforeWrite = async () => {
    admissions++;
    if (operation !== 'create' || admissions === 2) f.change('mode');
  };
  if (operation === 'restore') f.afterHistory(() => f.change('mode'));
  const action = () => operation === 'create'
    ? f.store.create({ artifactId: 'document', header: f.header, body: 'private replacement', beforeWrite })
    : operation === 'update'
      ? f.store.update({ artifactId: 'document', expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: f.header, body: 'private replacement', beforeWrite })
      : f.store.revisions.restore({ artifactId: 'document', bodyVersion: 1, expectedRevision: { headerVersion: 1, bodyVersion: 1 } });
  await expect(f.run(action)).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
  expect(f.channel.clients.every(client => client.connected)).toBe(true);
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 1, writes: 0 });
});

it.each(['create', 'update', 'restore'] as const)('freshly refuses Artifact %s after credential revocation before socket delivery', async operation => {
  const f = await fixture();
  let admissions = 0;
  const beforeWrite = async () => {
    admissions++;
    if (operation !== 'create' || admissions === 2) f.change('epoch');
  };
  if (operation === 'restore') f.afterHistory(() => f.change('epoch'));
  const action = () => operation === 'create'
    ? f.store.create({ artifactId: 'document', header: f.header, body: 'private replacement', beforeWrite })
    : operation === 'update'
      ? f.store.update({ artifactId: 'document', expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: f.header, body: 'private replacement', beforeWrite })
      : f.store.revisions.restore({ artifactId: 'document', bodyVersion: 1, expectedRevision: { headerVersion: 1, bodyVersion: 1 } });
  await expect(f.run(action)).rejects.toMatchObject({ code: 'account_encryption_mode_unavailable' });
  expect(f.channel.clients.every(client => client.connected)).toBe(true);
  expect(f.counts()).toEqual({ identityReads: 1, modeReads: 1, writes: 0 });
});
