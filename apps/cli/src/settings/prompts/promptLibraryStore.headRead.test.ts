import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1, readPromptLibraryCatalogRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRecordV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createRegistryHostV1, listRegistrySourcesV1 } from '@happier-dev/protocol/registries';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';

it.each(['sources', 'items', 'concurrent skill catalogs'] as const)('lists %s through the Action port with a constant head request shape and no history maintenance', async kind => {
  // Real HTTP and SQLite boundaries; production Action port, transport, admission and parsers stay real.
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE rows (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT)');
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(`${request.method} ${path}`);
    const rows = database.prepare('SELECT * FROM rows ORDER BY key').all();
    let result: unknown;
    if (path === '/v1/account/encryption/currentness') result = { mode: 'plain', version: 1, settingsVersion: 7,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 };
    else if (path === '/v1/account/entity-rows/prompt-library') result = { status: 'listed', rows: rows.map(row => ({
      key: row.key, revision: row.revision, content: row.record === null ? null : { t: 'plain', v: JSON.parse(String(row.record)) },
    })) };
    else if (path === '/v2/account/settings') result = { content: { t: 'plain', v: {} }, version: 7 };
    else if (path === '/v2/account/settings/history') result = { snapshots: [] };
    else { response.statusCode = 404; result = { error: 'unknown_route' }; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
  const base = `http://127.0.0.1:${address.port}`;
  const credentials = { token: 'head-read-account', encryption: null };
  try {
    await runWithServerHttpBaseUrl(base, async () => {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      const port = createCliApprovalsArtifactStore({ credentials, serverHttpBaseUrl: base,
        getAccountEncryptionMode: async () => 'plain' }).promptLibraryStore.organization!;
      const put = database.prepare('INSERT OR REPLACE INTO rows VALUES (?, 7, ?)');
      // Occupy all destinations so RED measures wasted maintenance, not first-use migration.
      for (const key of PromptLibraryCatalogKeyV1Schema.options) put.run(key, JSON.stringify(emptyPromptLibraryRecordV1(key)));
      for (const count of [1, 32]) {
        const record = PromptLibraryRecordV1Schema.parse({ key: 'registry-sources', value: { v: 2,
          disabledSourceIds: [], sources: Array.from({ length: count }, (_, index) => ({ id: `source-${index}`,
            title: `Source ${index}`, url: `https://github.com/registry-${index}/skills`, format: 'git', kinds: ['skill'], enabled: true, addedAt: 0 })) } });
        put.run(record.key, JSON.stringify(record));
        requests.length = 0;
        const host = createRegistryHostV1({ host: 'node', readSources: async () => {
          const projection = await port.readCatalog(undefined, 'registry-sources');
          const read = readPromptLibraryCatalogRecordV1({ ...projection, key: 'registry-sources' });
          if (read.status !== 'ready' || read.record.key !== 'registry-sources') throw new Error('Sources unavailable');
          return listRegistrySourcesV1({ record: read.record.value, pluginSources: [] }).filter(source => source.id.startsWith('source-'));
        }, http: {
          // Only the external GitHub HTTP boundary is synthetic; real format/host code runs.
          getJson: async url => ({ ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: '1'.repeat(40) }
            : { sha: '2'.repeat(40), tree: [{ path: 'review/SKILL.md', type: 'blob', mode: '100644', sha: '3'.repeat(40), size: 3 }] } }),
          getText: async () => { throw new Error('Listing must not read item bodies'); },
          getBytes: async () => { throw new Error('Listing must not download files'); },
        } });
        if (kind === 'concurrent skill catalogs') {
          const projections = await Promise.all((['skill-rules', 'skill-usage', 'folders'] as const).map(key => port.readCatalog(undefined, key)));
          expect(projections.every(projection => projection.catalog.status === 'ready')).toBe(true);
        } else {
          const output = await host.execute(kind === 'sources' ? 'registries.sources.list' : 'registries.items.list', kind === 'sources' ? {} : { kind: 'skill' });
          expect(kind === 'sources' ? Reflect.get(output as object, 'sources') : Reflect.get(output as object, 'pages')).toHaveLength(count);
        }
        expect(requests).toEqual([
          'GET /v1/account/encryption/currentness',
          'GET /v1/account/entity-rows/prompt-library',
          'GET /v1/account/encryption/currentness',
        ]);
      }
      if (kind === 'sources') {
        database.prepare('UPDATE rows SET record = NULL, revision = 8 WHERE key = ?').run('registry-sources');
        const deleted = readPromptLibraryCatalogRecordV1({ ...await port.readCatalog(undefined, 'registry-sources'), key: 'registry-sources' });
        expect(deleted).toMatchObject({ status: 'ready', authority: 'active', revision: 8, record: { value: { sources: [] } } });
        const controller = new AbortController();
        const reason = new Error('Cancelled head read');
        controller.abort(reason);
        requests.length = 0;
        await expect(port.readCatalog(controller.signal, 'registry-sources')).rejects.toBe(reason);
        expect(requests).toEqual([]);
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
          settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'retired-account' });
        await expect(port.readCatalog(undefined, 'registry-sources')).rejects.toMatchObject({ code: 'scope-retired' });
      }
    });
  } finally {
    resetActiveAccountSettingsSnapshotForTests();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    database.close();
  }
});
