import { describe, expect, it } from 'vitest';
import { MarketplaceIndexEntryV1Schema, MarketplaceIndexSourceSnapshotV1Schema } from '../../marketplace/marketplaceIndexV1.js';
import { deriveMarketplaceSourceId } from '../../marketplace/marketplaceSourceRegistryV1.js';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { RegistryItemV1Schema } from '../registryItemsV1.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '../registryActionsV1.js';
import type { RegistrySourceDescriptorV1 } from '../registrySourcesV1.js';
import { HAPPIER_PICKS_SOURCE_ID, listRegistrySourcesV1 } from '../registrySourcesV1.js';
import { createPluginRegistrySourceDescriptorV1 } from '../registryPluginSourcesV1.js';
import { readPromptLibraryCatalogRecordV1, updatePromptLibraryRegistrySourcesV1, type PromptLibraryStackActionPortV1 } from '../../prompts/library/promptLibraryCatalogV1.js';
import { StoredPromptLibraryRecordV1Schema } from '../../prompts/library/promptLibraryRowsV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';
import { computeGitBlobShaV1, computeGitTreeShaV1 } from '../registryGitTreeV1.js';
import { checkRegistryUpstreamV1 } from '../registryUpdatesV1.js';
import { ACP_REGISTRY_V1_FIXTURE } from './fixtures/acpRegistryV1Fixture.js';

describe('curated picks through the registered catalog and target reader', () => {
  const sources = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [] });
  const source = sources.find(source => source.id === HAPPIER_PICKS_SOURCE_ID)!;
  const commit = '1'.repeat(40);
  const files = [{ path: 'SKILL.md', unixMode: 0o644 as const, bytes: new TextEncoder().encode('---\nname: review-changes\ndescription: Review a change\n---\nInstructions\n') }];
  function fixture() {
    const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({
      source: { id: source.id, sourceUrl: source.url, title: source.title, kind: 'curated' },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [], picks: [
        { kind: 'skill', format: 'git', sourceUrl: 'https://github.com/example/skills', itemId: '' },
        { kind: 'skill', format: 'git', sourceUrl: 'https://github.com/other/skills', itemId: '' },
        { kind: 'skill', format: 'git', sourceUrl: 'https://github.com/example/skills', itemId: 'removed' },
      ],
    });
    let unavailable = false;
    const reads: string[] = [];
    const http: RegistryHttpV1 = {
      async getJson(url) { reads.push(url); return url === source.url
        ? unavailable ? { ok: false, status: { state: 'unreachable' } } : { ok: true, value: catalog, fetchedAt: 1 }
        : { ok: true, fetchedAt: 1, value: url.includes('/commits/') ? { sha: commit }
          : { sha: computeGitTreeShaV1(files), tree: files.map(file => ({ path: file.path, mode: '100644', type: 'blob', sha: computeGitBlobShaV1(file.bytes), size: file.bytes.length })) } }; },
      async getText() { return { ok: true, value: new TextDecoder().decode(files[0]!.bytes), fetchedAt: 1 }; },
      async getBytes() { return { ok: true, value: files[0]!.bytes, fetchedAt: 1 }; },
    };
    const host = createRegistryHostV1({ host: 'web', http, readSources: async () => sources,
      daemonFetch: async () => { throw new Error('Picks must not fetch a daemon'); } });
    return { host, http, catalog, reads, unavailable: () => { unavailable = true; } };
  }
  it('resolves colliding root skill pointers independently, pins reviewed bytes, and reports a removed pointer per item', async () => {
    const { host, reads } = fixture();
    const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'skill', sourceIds: [source.id],
    }));
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.status.state).toBe('ok');
    expect(page.items).toHaveLength(3);
    const [first, second, removed] = page.items;
    expect(first).toMatchObject({ sourceId: source.id, title: 'review-changes', flags: { pick: true }, version: commit });
    expect(second!.itemId).not.toBe(first!.itemId);
    expect(removed).toMatchObject({ flags: { pick: true }, problem: { code: 'removed_from_source' } });
    const read = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'skill', sourceId: source.id, itemId: second!.itemId, version: commit,
    }));
    const consumed = RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(read.item)));
    expect(consumed.payload).toMatchObject({ kind: 'skill', skill: { ref: { repo: 'https://github.com/other/skills', commit }, skillMarkdown: new TextDecoder().decode(files[0]!.bytes) } });
    expect(consumed.summary.itemId).toBe(second!.itemId);
    expect(await host.filesForPointer({ sourceId: source.id, itemId: first!.itemId, version: commit })).toEqual(files);
    expect(reads.some(url => url.includes('/repos/example/skills/commits/'))).toBe(true);
    expect(reads.some(url => url.includes('/repos/other/skills/commits/'))).toBe(true);
  });
  it('quietly omits an empty or unavailable picks kind while preserving plugin catalog failures', async () => {
    const { host, catalog, unavailable } = fixture();
    catalog.picks = [];
    expect(await host.execute('registries.items.list', { kind: 'skill', sourceIds: [source.id] })).toEqual({ pages: [] });
    expect(await host.execute('registries.sources.list', { kind: 'skill' })).not.toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: source.id })]) });
    unavailable();
    expect(await host.execute('registries.items.list', { kind: 'skill', sourceIds: [source.id] })).toEqual({ pages: [] });
    expect(await host.execute('registries.items.list', { kind: 'plugin', sourceIds: [source.id] })).toMatchObject({ pages: [{ status: { state: 'unreachable' } }] });
  });
  it('keeps healthy picks when another target HTTP transport rejects', async () => {
    const { http } = fixture();
    const host = createRegistryHostV1({ host: 'web', readSources: async () => sources, http: { ...http,
      getJson: async (url, options) => { if (url.includes('/repos/other/')) throw new TypeError('Failed to fetch'); return http.getJson(url, options); } } });
    const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', { kind: 'skill', sourceIds: [source.id] }));
    expect(result.pages[0]?.items).toHaveLength(2);
    expect(result.pages[0]?.status.state).toBe('ok');
    expect(result.pages[0]?.items[0]?.title).toBe('review-changes');
  });
  it('checks the actual target of an installed pick through the canonical update owner', async () => {
    const { host, http, catalog } = fixture();
    const page = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', { kind: 'skill', sourceIds: [source.id] }));
    const summary = page.pages[0]!.items[0]!;
    const { item } = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'skill', sourceId: source.id, itemId: summary.itemId, version: summary.version,
    }));
    if (item.payload.kind !== 'skill') throw new Error('Expected skill');
    const provenance = { sourceId: source.id, sourceUrl: source.url, format: source.format, itemId: summary.itemId, importedAt: 1, ref: item.payload.skill.ref };
    expect((await checkRegistryUpstreamV1({ http }, { sources, items: [{ key: 'installed', provenance }] })).get('installed')).toMatchObject({ state: 'current', latest: { treeSha: item.payload.skill.ref.treeSha } });
    catalog.picks = [];
    expect((await checkRegistryUpstreamV1({ http }, { sources, items: [{ key: 'installed', provenance }] })).get('installed')).toEqual({ state: 'removed_from_source' });
  });
  it('preserves native Agent ids and strict pinned payloads, and refuses an ambiguous curated Agent pointer', async () => {
    const { catalog, http } = fixture();
    let index: unknown = ACP_REGISTRY_V1_FIXTURE;
    const url = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
    catalog.picks = [{ kind: 'agent', format: 'acp-registry', sourceUrl: url, itemId: 'goose' }];
    const host = createRegistryHostV1({ host: 'web', readSources: async () => sources, http: { ...http,
      getJson: async (request, options) => request === source.url ? http.getJson(request, options) : { ok: true, value: index, fetchedAt: 1 } } });
    const page = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', { kind: 'agent', sourceIds: [source.id] }));
    expect(page.pages[0]!.items[0]).toMatchObject({ sourceId: source.id, itemId: 'goose', flags: { pick: true }, version: '1.54.0' });
    const { item } = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'agent', sourceId: source.id, itemId: 'goose', version: '1.54.0',
    }));
    expect(RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(item))).payload).toMatchObject({ kind: 'agent', agent: { id: 'goose', version: '1.54.0' } });
    index = { version: '1.0.0', agents: [{ ...ACP_REGISTRY_V1_FIXTURE.agents[2], distribution: { npx: { package: 'goose@latest' } } }] };
    expect(await host.execute('registries.items.list', { kind: 'agent', sourceIds: [source.id] })).toMatchObject({ pages: [{ items: [
      { itemId: 'goose', problem: { code: 'unsupported_entry', reason: 'distribution' } },
    ] }] });
    catalog.picks.push({ ...catalog.picks[0]!, sourceUrl: 'https://other.example/registry.json' });
    expect(await host.execute('registries.items.list', { kind: 'agent', sourceIds: [source.id] })).toMatchObject({ pages: [{ items: [
      { problem: { code: 'unsupported_entry' } }, { problem: { code: 'unsupported_entry' } },
    ] }] });
    await expect(host.execute('registries.items.read', { kind: 'agent', sourceId: source.id, itemId: 'goose', version: '1.54.0' })).rejects.toMatchObject({ status: { state: 'invalid_source' } });
  });
});

describe('catalog registry production composition', () => {
  it('does not give arbitrary or noncanonical slash strings source identity', () => {
    for (const id of ['arbitrary/slash', 'com.acme.sources//team', 'com.acme.sources/team\n']) {
      expect(MarketplaceIndexSourceSnapshotV1Schema.shape.source.safeParse({ id, title: 'Invalid declaration', kind: 'user',
        sourceUrl: 'https://catalog.example/plugins.json' }).success).toBe(false);
    }
  });
  it.each(['https://catalog.example/plugins.json', 'https://catalog.example/'])('creates and reads %s with its published identity and strict plugin payload', async (url) => {
    const source: RegistrySourceDescriptorV1 = { id: deriveMarketplaceSourceId(url), url, title: 'Team', format: 'happier-catalog',
      kinds: ['plugin'], enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
    const entry = MarketplaceIndexEntryV1Schema.parse({ pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' },
      display: { title: 'Plugin', description: 'Team plugin' }, distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: '@acme/plugin',
        version: '1.0.0', integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
      manifestDigest: `sha256:${'a'.repeat(64)}`, compatibility: { platforms: ['linux'] }, summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
      review: { status: 'unreviewed', reviewedAt: null }, categories: [], media: [], updatePolicy: 'allowed', links: {} });
    const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: { id: source.id, title: source.title, sourceUrl: url, kind: 'user' },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [entry], diagnostics: [] });
    const http: RegistryHttpV1 = { getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
      getText: async () => { throw new Error('Unexpected text'); }, getBytes: async () => { throw new Error('Unexpected bytes'); } };
    let revision = 0;
    let pluginSources: readonly RegistrySourceDescriptorV1[] = [];
    let stored = StoredPromptLibraryRecordV1Schema.parse({ key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] } });
    // Only storage is substituted; create, Account-row CAS, identity selection,
    // source projection, adapter registration and wire consumption remain real.
    const port: PromptLibraryStackActionPortV1 = { serverId: 'account-test', assertCurrent() {},
      readCatalog: async () => ({ catalog: { status: 'ready', rows: [{ record: stored, revision }], tombstones: [], diagnostics: [] } }),
      writeRecord: async input => { if (input.expectedRevision !== revision) return { status: 'conflict', revision };
        stored = StoredPromptLibraryRecordV1Schema.parse(input.record); return { status: 'updated', revision: ++revision }; },
    };
    const host = createRegistryHostV1({ host: 'web', http,
      readSources: async () => { const snapshot = await port.readCatalog();
        const read = readPromptLibraryCatalogRecordV1({ ...snapshot, key: 'registry-sources' });
        if (read.status !== 'ready' || read.record.key !== 'registry-sources') throw new Error('Expected Account sources');
        return listRegistrySourcesV1({ record: read.record.value, pluginSources }); },
      mutateSources: mutation => updatePromptLibraryRegistrySourcesV1(port, mutation),
    });
    expect(await host.execute('registries.sources.detect', { url })).toMatchObject({ detected: { format: 'happier-catalog', kinds: ['plugin'] } });
    expect(await host.execute('registries.sources.create', { url })).toMatchObject({ source: { id: deriveMarketplaceSourceId(url), format: 'happier-catalog' }, existing: false });
    expect(await host.execute('registries.sources.create', { url })).toMatchObject({ source: { id: deriveMarketplaceSourceId(url) }, existing: true });
    expect(await host.execute('registries.items.list', { kind: 'plugin', sourceIds: [source.id] })).toMatchObject({ pages: [{ items: [{ itemId: 'acme.plugin', version: '1.0.0' }] }] });
    const read = await host.fetchRequest({ op: 'read', kind: 'plugin', sourceId: source.id, itemId: 'acme.plugin', version: '1.0.0' });
    if (read.op !== 'read') throw new Error('Expected catalog read');
    expect(RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(read.item))).payload).toEqual({ kind: 'plugin', listing: entry, source: catalog.source });
    const newer = MarketplaceIndexEntryV1Schema.parse({ ...entry, distribution: { ...entry.distribution, version: '2.0.0' } });
    catalog.entries = [newer, entry];
    expect(await host.execute('registries.items.list', { kind: 'plugin', sourceIds: [source.id] }))
      .toMatchObject({ pages: [{ items: [{ itemId: 'acme.plugin', version: '2.0.0' }] }] });
    const pinned = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read',
      { kind: 'plugin', sourceId: source.id, itemId: 'acme.plugin', version: '1.0.0' }));
    expect(RegistryItemV1Schema.parse(pinned.item).payload).toEqual({ kind: 'plugin', listing: entry, source: catalog.source });
    const declared = createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.sources', suppliers: ['installed-source-plugin'],
      definition: { id: 'team', title: 'Team declaration', format: 'happier-catalog', kinds: ['plugin'], url } });
    pluginSources = [declared];
    const declaredRead = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read',
      { kind: 'plugin', sourceId: declared.id, itemId: 'acme.plugin', version: '1.0.0' }));
    const consumed = RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(declaredRead.item)));
    expect(consumed.summary.sourceId).toBe(declared.id);
    expect(consumed.payload).toEqual({ kind: 'plugin', listing: entry,
      source: { id: declared.id, title: declared.title, sourceUrl: url, kind: 'user' } });
    catalog.source.id = 'marketplace:other';
    expect(await host.execute('registries.items.list', { kind: 'plugin', sourceIds: [source.id] })).toMatchObject({ pages: [{ status: { state: 'invalid_source' }, items: [] }] });
  });
});
