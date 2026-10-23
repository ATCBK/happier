import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { readAccountNoticeArtifactV1, readAccountNoticeArtifactHeaderV1, AccountNoticeArtifactHeaderV1Schema, AccountNoticeArtifactBodyV1Schema,
  UsageNoticeArtifactHeaderV1Schema, UsageNoticeArtifactBodyV1Schema, type UsageNoticeArtifactHeaderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { ArtifactAccessRecipientCensusResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { decodeArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { openEncryptedDataKeyEnvelopeV1, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { decodeBase64, decryptWithDataKey, encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createStablePluginNotificationsService, type StablePluginNotificationsHost } from './notifications';

describe('plugin notification Account Artifact custody', () => {
  it.each(['plain', 'e2ee'] as const)('persists and updates one %s private item with badges disabled, preserving dismissal, resolution, and plugin isolation', async mode => {
    // Real service + mode-aware Artifact codec + HTTP transport. This server is
    // the persistent-service boundary, including the real revision contract.
    type Row = { id: string; kind?: string; header: string; body: string; dataEncryptionKey: string; headerVersion: number; bodyVersion: number };
    const rows = new Map<string, Row>();
    let accountMode = mode;
    const secret = randomBytes(32);
    const decodeHeader = (row: Row) => {
      if (accountMode === 'plain') return decodePlainArtifactStoredContent(row.header);
      const key = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(row.dataEncryptionKey), recipientSecretKeyOrSeed: secret });
      if (!key) throw new Error('Missing test Artifact key');
      return decryptWithDataKey(decodeBase64(row.header), key);
    };
    const encodeHeader = (row: Row, header: unknown) => {
      if (accountMode === 'plain') return encodePlainArtifactStoredContent(header);
      const key = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(row.dataEncryptionKey), recipientSecretKeyOrSeed: secret });
      if (!key) throw new Error('Missing test Artifact key');
      return encodeBase64(encryptWithDataKey(header, key));
    };
    let dismissDuringUpdate = false;
    const wireRow = (row: Row) => {
      const kind = decodeArtifactKindV1(row.kind);
      return { ...row, kind: kind.kind, ...(kind.classified ? { kindHint: kind.kindHint } : {}),
        ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: accountMode,
        seq: 1, createdAt: 1, updatedAt: 2 };
    };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const id = decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length));
      const existing = rows.get(id);
      const reply = (status: number, value: unknown) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      if (request.method === 'GET' && url.pathname.endsWith('/access/recipients')) {
        request.resume();
        const row = rows.get(decodeURIComponent(url.pathname.split('/')[3]!));
        return row ? reply(200, ArtifactAccessRecipientCensusResponseV1Schema.parse({ artifactId: row.id,
          ownerAccountId: 'owner', encryptionMode: accountMode, access: 'owner',
          dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey, recipients: [] })) : reply(404, {});
      }
      if (request.method === 'GET' && url.pathname === '/v1/artifacts') {
        request.resume();
        const kinds: unknown = url.searchParams.has('kinds') ? JSON.parse(url.searchParams.get('kinds')!) : undefined;
        const coarse = url.searchParams.get('kind');
        const unclassified = url.searchParams.get('unclassified');
        const selected = [...rows.values()].filter(row => unclassified ? unclassified === 'coarse' ? row.kind == null : !decodeArtifactKindV1(row.kind).classified
          : Array.isArray(kinds) ? kinds.includes(decodeArtifactKindV1(row.kind).kindHint) : !coarse || decodeArtifactKindV1(row.kind).kind === coarse);
        const cursor = url.searchParams.get('cursor');
        const after = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id: string } : null;
        const start = after ? selected.findIndex(row => row.id === after.id) + 1 : 0;
        const items = selected.slice(start, start + Number(url.searchParams.get('limit') ?? 500)).map(row => {
          const { body, ...header } = wireRow(row);
          return { ...header, ...(url.searchParams.get('includeBody') ? { body } : {}) };
        });
        return reply(200, kinds !== undefined || coarse || unclassified ? { items,
          hasUnclassified: [...rows.values()].some(row => kinds !== undefined || unclassified === 'true' ? !decodeArtifactKindV1(row.kind).classified : row.kind == null) } : items);
      }
      if (request.method === 'GET') {
        request.resume();
        return existing ? reply(200, wireRow(existing)) : reply(404, {});
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (url.pathname === '/v1/artifacts') {
        if (rows.has(input.id)) return reply(409, { error: 'conflict' });
        const row: Row = { ...input, headerVersion: 1, bodyVersion: 1 };
        rows.set(row.id, row);
        return reply(200, row);
      }
      if (!existing) return reply(404, {});
      if (input.kind !== undefined && input.header === undefined && input.body === undefined) {
        if (input.expectedHeaderVersion !== existing.headerVersion) return reply(409, { success: false, error: 'version-mismatch' });
        existing.kind = input.kind;
        return reply(200, { success: true });
      }
      if (dismissDuringUpdate) {
        dismissDuringUpdate = false;
        existing.header = encodeHeader(existing, { ...decodeHeader(existing) as object, status: 'dismissed', readAt: 100 });
        existing.headerVersion += 1;
      }
      if (input.expectedHeaderVersion !== existing.headerVersion || input.expectedBodyVersion !== existing.bodyVersion) {
        return reply(200, { success: false, error: 'version-mismatch' });
      }
      existing.header = input.header;
      existing.body = input.body;
      existing.kind = input.kind;
      existing.headerVersion += 1;
      existing.bodyVersion += 1;
      return reply(200, { success: true, headerVersion: existing.headerVersion, bodyVersion: existing.bodyVersion });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test HTTP address');
    try {
      await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials = { token, encryption: mode === 'plain' ? null : {
          type: 'dataKey' as const, publicKey: x25519.getPublicKey(secret), machineKey: secret,
        } };
        const store = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => accountMode });
        let activeStore = store;
        const migrateAccountMode = () => {
          const targetMode = accountMode === 'plain' ? 'e2ee' : 'plain';
          for (const row of rows.values()) {
            const header = decodeHeader(row);
            const key = accountMode === 'plain' ? null : openEncryptedDataKeyEnvelopeV1({
              envelope: decodeBase64(row.dataEncryptionKey), recipientSecretKeyOrSeed: secret });
            const body = accountMode === 'plain' ? decodePlainArtifactStoredContent(row.body)
              : decryptWithDataKey(decodeBase64(row.body), key!);
            const targetKey = randomBytes(32);
            row.dataEncryptionKey = targetMode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
              : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: targetKey, recipientPublicKey: x25519.getPublicKey(secret), randomBytes }));
            row.header = targetMode === 'plain' ? encodePlainArtifactStoredContent(header) : encodeBase64(encryptWithDataKey(header, targetKey));
            row.body = targetMode === 'plain' ? encodePlainArtifactStoredContent(body) : encodeBase64(encryptWithDataKey(body, targetKey));
          }
          accountMode = targetMode;
          activeStore = createAccountArtifactStore({ credentials: { token, encryption: accountMode === 'plain' ? null : {
            type: 'dataKey', publicKey: x25519.getPublicKey(secret), machineKey: secret } }, getAccountEncryptionMode: async () => accountMode });
        };
        const seed = { plugin: { id: 'acme.tasks', version: '1.0.0' }, contribution: { id: 'run', qualifiedId: 'acme.tasks/actions/run' },
          occurrenceId: 'one', correlationId: 'one', surface: 'cli' as const, signal: new AbortController().signal, isOccurrenceCurrent: () => true };
        const host = { categories: [{ pluginId: 'acme.tasks',
          definition: { id: 'updates', kind: 'plugin' as const, title: 'Updates', eventIds: [] } }], channels: [],
          readAttentionPolicy: () => ({ channels: { badge: { enabled: false } } }),
          async activateChannel() {}, readChannel: () => null,
          resolveNoticeArtifacts: async () => ({ accountId: 'owner', store: activeStore }) } satisfies StablePluginNotificationsHost;
        const service = createStablePluginNotificationsService(seed, host);
        const input = { clientRequestId: 'first', categoryId: 'updates', title: 'First', itemId: 'task-1', type: 'update' as const };
        await service.send(input);
        expect(rows.size).toBe(1);
        expect(readAccountNoticeArtifactV1((await store.read([...rows.keys()][0]!, { includeSharedAudience: false }))!))
          .toMatchObject({ title: 'First', source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: 'task-1' } });
        dismissDuringUpdate = true;
        await service.send({ ...input, clientRequestId: 'second', title: 'Changed' });
        expect(rows.size).toBe(1);
        const artifactId = [...rows.keys()][0]!;
        const opened = await store.read(artifactId);
        expect(readAccountNoticeArtifactV1(opened!)).toMatchObject({ title: 'Changed', status: 'dismissed', readAt: 100,
          source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: 'task-1' }, resolved: false });
        await expect(service.send({ ...input, title: 'Changed under same request' })).rejects.toMatchObject({ code: 'plugin_notification_request_conflict' });
        await service.send({ ...input, clientRequestId: 'third', resolved: true });
        expect(readAccountNoticeArtifactV1((await store.read(artifactId))!)).toMatchObject({ resolved: true, status: 'dismissed' });
        // Account migration rewrites envelopes at their existing IDs. Its real
        // server owner uses row.id for every head/history update; this boundary
        // conversion preserves that contract in both mode directions.
        migrateAccountMode();
        await service.send({ ...input, clientRequestId: 'migrated-update', title: 'After mode change' });
        expect(rows.size).toBe(1);
        expect(readAccountNoticeArtifactV1((await activeStore.read(artifactId))!)).toMatchObject({ title: 'After mode change', status: 'dismissed', readAt: 100 });
        await service.send({ ...input, clientRequestId: 'migrated-resolve', resolved: true });
        expect(readAccountNoticeArtifactV1((await activeStore.read(artifactId))!)).toMatchObject({ resolved: true, status: 'dismissed' });
        for (const legacy of [false, true]) {
          const notices: UsageNoticeArtifactHeaderV1['notice'][] = [{ topic: 'resource_limit', kind: 'memory_pressure', phase: 'started',
            machineId: legacy ? 'legacy-machine' : 'current-machine', at: 100, since: 0, guardEnabled: false,
            evidence: { level: 'elevated', sustainMs: 100 } }, {
            topic: 'connected_service_usage', kind: 'credit_expiry', serviceId: 'service', profileId: 'profile',
            issueFingerprint: legacy ? 'legacy-issue' : 'current-issue', evidence: { recordId: 'paug_v1_12345678',
              creditId: 'credit', expiresAtMs: 1000, observedAtMs: 100, previousObservedAtMs: 0 },
          }];
          for (const notice of notices) {
          const content = AccountNoticeArtifactBodyV1Schema.parse({ v: 1, source: { kind: 'host', topic: notice.topic },
            type: 'update', resolved: false, notice });
          const header = AccountNoticeArtifactHeaderV1Schema.parse({ ...content, kind: 'account_notice.v1', title: 'Host alert', status: 'open' });
          const createHost = (event: UsageNoticeArtifactHeaderV1['notice']) => activeStore.create({ noticeAccountId: 'owner',
            header: { ...header, notice: event }, body: JSON.stringify({ ...content, notice: event }) });
          const created = await createHost(notice);
          const retained = rows.get(created.artifactId)!;
          retained.kind = legacy ? undefined : 'other';
          retained.header = encodeHeader(retained, legacy
            ? UsageNoticeArtifactHeaderV1Schema.parse({ v: 1, kind: 'usage_notice.v1', title: 'Host alert', status: 'dismissed', notice })
            : { ...header, status: 'dismissed', readAt: 100 });
          if (legacy) {
            const body = { body: JSON.stringify(UsageNoticeArtifactBodyV1Schema.parse({ v: 1, notice })) };
            retained.body = accountMode === 'plain' ? encodePlainArtifactStoredContent(body)
              : encodeHeader(retained, body);
          }
          const count = rows.size;
          migrateAccountMode();
          await expect(createHost(notice.topic === 'resource_limit' ? { ...notice, machineName: 'Updated display' }
            : { ...notice, evidence: { ...notice.evidence, observedAtMs: 101 } })).rejects.toMatchObject({ code: 'conflict' });
          expect(rows.size).toBe(count);
          expect(decodeHeader(retained)).toMatchObject({ status: 'dismissed' });
          await createHost(notice.topic === 'resource_limit' ? { ...notice, at: 101 }
            : { ...notice, issueFingerprint: `${notice.issueFingerprint}-next` });
          expect(rows.size).toBe(count + 1);
          }
        }
        const beforeOther = rows.size;
        const otherSeed = { ...seed, plugin: { ...seed.plugin, id: 'other.tasks' } };
        const other = createStablePluginNotificationsService(otherSeed, { ...host, categories: [{ ...host.categories[0]!, pluginId: 'other.tasks' }] });
        await other.send(input);
        expect(rows.size).toBe(beforeOther + 1);
        expect(readAccountNoticeArtifactV1((await activeStore.read(artifactId))!)?.source).toEqual({ kind: 'plugin', pluginId: 'acme.tasks', itemId: 'task-1' });
        await expect(service.send({ ...input, clientRequestId: 'spoof', source: { pluginId: 'other.tasks' } } as typeof input))
          .rejects.toMatchObject({ code: 'plugin_notification_invalid_request' });
        const otherArtifactId = [...rows.values()].find(row => {
          const source = readAccountNoticeArtifactHeaderV1(decodeHeader(row))?.source;
          return source?.kind === 'plugin' && source.pluginId === 'other.tasks';
        })!.id;
        const victim = rows.get(otherArtifactId)!;
        victim.header = encodeHeader(victim, { ...decodeHeader(victim) as object,
          source: { kind: 'plugin', pluginId: 'acme.tasks', itemId: 'task-1' } });
        await expect(other.send({ ...input, clientRequestId: 'corrupt-ownership' })).rejects.toMatchObject({ code: 'notice_owner_mismatch' });
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
