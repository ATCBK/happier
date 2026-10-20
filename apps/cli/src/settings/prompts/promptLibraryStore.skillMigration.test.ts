import { it } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import captured from '../../../../../packages/protocol/fixtures/0.2-picker-skill-instructions-stack.json';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1, readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRecordV1Schema, StoredPromptLibraryRecordV1Schema, PromptLibraryRowMutationV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { resolvePromptStackSystemAppendBlocksV1 } from '@happier-dev/protocol/prompts/library/resolvePromptStackSystemAppendBlocksV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';

it.each([undefined, 'srv_migration_home', 'srv_foreign_home'])('admits only own-Home predecessor skill migration for %s through real CLI HTTP and SQLite', async homeId => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE rows (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL)');
  const insert = database.prepare('INSERT INTO rows VALUES (?, 1, ?)');
  const legacy = captured.stacks.surfaces.coding.map(entry => ({ ...entry,
    ref: { ...entry.ref, ...(homeId ? { serverId: homeId } : {}) } }));
  for (const key of PromptLibraryCatalogKeyV1Schema.options) {
    const record = key === 'coding' || key === 'voice'
      ? StoredPromptLibraryRecordV1Schema.parse({ key, value: { v: 1, scope: { kind: key }, entries: legacy } })
      : emptyPromptLibraryRecordV1(key);
    insert.run(key, JSON.stringify(record));
  }
  let mutations = 0;
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      requests.push(path);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      let result: unknown;
      if (path === '/v1/account/entity-rows/prompt-library') {
        result = { status: 'listed', rows: database.prepare('SELECT * FROM rows ORDER BY key').all().map(row => ({
          key: row.key, revision: row.revision, content: { t: 'plain', v: JSON.parse(String(row.record)) },
        })) };
      } else if (path.startsWith('/v1/account/entity-rows/prompt-library/')) {
        const key = decodeURIComponent(path.split('/').at(-1)!);
        const mutation = PromptLibraryRowMutationV1Schema.parse(JSON.parse(Buffer.concat(chunks).toString()));
        assert.equal(mutation.content?.t, 'plain');
        if (mutation.content?.t !== 'plain') throw new Error('Expected plain Account row');
        const record = PromptLibraryRecordV1Schema.parse(mutation.content.v);
        assert.equal(record.key, key);
        const updated = database.prepare('UPDATE rows SET record = ?, revision = revision + 1 WHERE key = ? AND revision = ?')
          .run(JSON.stringify(record), key, mutation.expectedRevision);
        const row = database.prepare('SELECT revision FROM rows WHERE key = ?').get(key)!;
        result = updated.changes === 1 ? { status: 'updated', revision: row.revision, cursor: ++mutations }
          : { status: 'conflict', revision: row.revision };
      } else if (path.startsWith('/v1/artifacts/')) {
        const artifact = captured.artifacts.find(item => item.id === decodeURIComponent(path.split('/').at(-1)!));
        if (!artifact) { response.statusCode = 404; result = { error: 'not_found' }; }
        else result = { id: artifact.id, ownerAccountId: 'migration-account', access: 'owner', encryptionMode: 'plain',
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: artifact.revision.headerVersion,
          bodyVersion: artifact.revision.bodyVersion, seq: 1, createdAt: 1, updatedAt: 1,
          header: encodePlainArtifactStoredContent(artifact.header), body: encodePlainArtifactStoredContent({ body: artifact.body }) };
      } else if (path === '/v1/account/encryption') result = { mode: 'plain', updatedAt: 1 };
      else if (path === '/v1/account/encryption/currentness') result = { mode: 'plain', version: 1, settingsVersion: 7,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
      else if (path === '/v2/account/settings') result = { content: { t: 'plain', v: {} }, version: 7 };
      else if (path === '/v2/account/settings/history') result = { snapshots: [] };
      else if (path === '/v1/account/entity-rows/profiles/transfer') result = { status: 'absent' };
      else { response.statusCode = 404; result = { error: 'unknown_route', path }; }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result));
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
  const base = `http://127.0.0.1:${address.port}`;
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'migration-account' })).toString('base64url')}.signature`, encryption: null,
    requesterSessionCredentialScope: { serverId: 'migration-profile', serverHttpBaseUrl: base } };
  if (homeId) {
    const { setServerProfileEndpointsById, adoptServerProfileHomeConnectionDescriptor } = await import('@/server/serverProfiles');
    await setServerProfileEndpointsById({ id: 'migration-profile', serverUrl: 'https://migration-home.invalid', webappUrl: 'https://migration-home.invalid' });
    await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: 'migration-profile', observation: 'exact', descriptor: {
      v: 1, homeServerIdentityId: 'srv_migration_home', canonicalServerUrl: 'https://migration-home.invalid', revision: 1,
      endpoints: [{ kind: 'https', url: 'https://migration-home.invalid' }],
    } });
  }
  try {
    await runWithServerHttpBaseUrl(base, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const store = createCliPromptLibraryStore({ credentials });
      const first = (await store.readCatalog(undefined, 'coding')).catalog;
      if (homeId === 'srv_foreign_home') {
        assert.equal(first.status, 'partial');
        assert.equal(mutations, 0);
        assert.equal(requests.some(path => path.startsWith('/v1/artifacts/')), false);
        return;
      }
      assert.equal(first.status, 'ready');
      const coding = readPromptLibraryCatalogRecordV1({ catalog: first, key: 'coding' });
      const voice = readPromptLibraryCatalogRecordV1({ catalog: first, key: 'voice' });
      const rules = readPromptLibraryCatalogRecordV1({ catalog: first, key: 'skill-rules' });
      if (coding.status !== 'ready' || coding.record.key !== 'coding' || voice.status !== 'ready' || voice.record.key !== 'voice'
        || rules.status !== 'ready' || rules.record.key !== 'skill-rules') throw new Error('Migration destinations unavailable');
      assert.deepEqual(coding.record.value.entries.map(item => item.id), ['before-entry', 'skill-entry', 'after-entry']);
      assert.deepEqual(voice.record.value.entries.map(item => item.id), ['before-entry', 'after-entry']);
      assert.equal(rules.record.value.rules.find(rule => rule.skillId === 'session-control-skill')?.id, 'migrated-stack:account:skill-entry');
      assert.equal(mutations, 2);
      assert.equal(requests.some(path => path.startsWith('/v2/account/settings')), false);
      assert.equal((await store.readPromptLibraryCatalog()).status, 'ready');
      assert.equal(mutations, 2);
      const output = await resolvePromptStackSystemAppendBlocksV1({ surface: 'coding', accountEntries: coding.record.value.entries,
        readArtifact: async ref => captured.artifacts.find(artifact => artifact.id === ref.artifactId) ?? null });
      assert.deepEqual(output.blocks, ['Before the skill: preserve the working tree.', 'After the skill: report the checks actually run.']);
    });
  } finally {
    resetActiveAccountSettingsSnapshotForTests();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    database.close();
  }
});
