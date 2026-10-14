import { describe, expect, it } from 'vitest';
import { createPluginCompatibilityProjectionV1 } from '../../plugins/availability/compatibilityProjectionV1.js';
import { createMarketplaceNpmDiscoveryProjectionV1, MarketplaceIndexSourceSnapshotV1Schema } from '../../marketplace/marketplaceIndexV1.js';
import { projectCommunityNpmListingV1 } from '../../marketplace/communityNpmDiscoveryV1.js';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, deriveMarketplaceSourceId } from '../../marketplace/marketplaceSourceRegistryV1.js';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { HAPPIER_PICKS_SOURCE_ID, listRegistrySourcesV1 } from '../registrySourcesV1.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '../registryActionsV1.js';
import { RegistryItemV1Schema } from '../registryItemsV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';
import { ACP_REGISTRY_V1_FIXTURE } from './fixtures/acpRegistryV1Fixture.js';

function publishedPlugin(agent: boolean, version = '1.0.0') {
  const pluginId = agent ? 'acme.agent' : 'acme.other';
  const packageName = agent ? '@acme/agent' : '@acme/other';
  const compatibility = createPluginCompatibilityProjectionV1({
    manifest: { schemaVersion: 2, id: pluginId, version, displayName: agent ? 'Community Agent' : 'Other plugin',
      runtime: { apiVersion: 1 }, entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] },
      contributes: agent ? { agents: [{ id: 'coding', title: 'Coding', primary: 'sessions', runtime: { kind: 'custom' },
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }] } : {} },
    uiArtifacts: { version: 2, entries: [] },
  });
  const integrity = 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==';
  const metadata = { name: packageName, version, _npmUser: { name: 'acme' },
    dist: { integrity, tarball: `https://registry.npmjs.org/${pluginId}.tgz` },
    happier: { compatibilityProjection: compatibility,
      marketplaceDiscovery: createMarketplaceNpmDiscoveryProjectionV1({ compatibility, manifestDigest: `sha256:${'a'.repeat(64)}` }) } };
  const listing = projectCommunityNpmListingV1({ versionMetadata: metadata, packageName, version, integrity,
    registryOrigin: 'https://registry.npmjs.org', publisher: { id: 'acme', displayName: 'Acme' } });
  if (listing.status !== 'listed') throw new Error('Canonical plugin fixture must publish');
  return { packageName, version, metadata, entry: listing.entry };
}

describe('plugin-contributed Agents through the generic registry owner', () => {
  it('browses npm Agent plugins without a Machine, keeps continuation and exact plugin identity, and rejects non-Agent reads', async () => {
    const agent = publishedPlugin(true), other = publishedPlugin(false);
    const sources = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [] });
    const http: RegistryHttpV1 = {
      getJson: async url => ({ ok: true, fetchedAt: 1, value: url.includes('/-/v1/search')
        ? { total: 3, objects: [other, agent].map(plugin => ({ package: { name: plugin.packageName, version: plugin.version, publisher: { username: 'acme' } } })) }
        : (() => { const plugin = url.endsWith(encodeURIComponent(agent.packageName)) ? agent : other;
          return { name: plugin.packageName, versions: { [plugin.version]: plugin.metadata }, 'dist-tags': { latest: plugin.version } }; })() }),
      getText: async () => { throw new Error('Unexpected text'); }, getBytes: async () => { throw new Error('Unexpected bytes'); },
    };
    const host = createRegistryHostV1({ host: 'web', http, readSources: async () => sources });
    const listedSources = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(await host.execute('registries.sources.list', { kind: 'agent' }));
    expect(listedSources.sources.some(source => source.id === COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1)).toBe(true);
    const listed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'agent', sourceIds: [COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1],
    }));
    expect(listed.pages[0]?.items).toMatchObject([{ kind: 'plugin', itemId: agent.packageName, version: agent.version }]);
    expect(listed.pages[0]?.items).toHaveLength(1);
    expect(listed.pages[0]?.nextCursor).toBe('2');
    const read = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'agent', sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, itemId: agent.packageName, version: agent.version,
    }));
    expect(RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(read.item))).payload).toMatchObject({
      kind: 'plugin', listing: { pluginId: agent.entry.pluginId, summary: { contributions: ['agents'] } },
    });
    await expect(host.execute('registries.items.read', { kind: 'agent', sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1,
      itemId: other.packageName, version: other.version })).rejects.toMatchObject({ status: { state: 'invalid_source' } });
    const allPlugins = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'plugin', sourceIds: [COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1],
    }));
    expect(allPlugins.pages[0]?.items).toHaveLength(2);
  });

  it('mixes curated ACP pointers and Agent plugin picks, filters unrelated plugins, and preserves reviewed versions', async () => {
    const agent = publishedPlugin(true), newer = publishedPlugin(true, '2.0.0'), other = publishedPlugin(false);
    const curatedAgent = { ...agent.entry, review: { status: 'approved', reviewedAt: '2026-10-14T00:00:00Z' } };
    const sources = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [] });
    const source = sources.find(source => source.id === HAPPIER_PICKS_SOURCE_ID)!;
    const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({
      source: { id: source.id, sourceUrl: source.url, title: source.title, kind: 'curated' },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [newer.entry, agent.entry, other.entry].map(entry => ({
        ...entry, review: { status: 'approved', reviewedAt: '2026-10-14T00:00:00Z' },
      })), diagnostics: [],
      picks: [{ kind: 'agent', format: 'acp-registry', sourceUrl: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json', itemId: 'goose' }],
    });
    const http: RegistryHttpV1 = { getJson: async url => ({ ok: true, fetchedAt: 1, value: url === source.url ? catalog : ACP_REGISTRY_V1_FIXTURE }),
      getText: async () => { throw new Error('Unexpected text'); }, getBytes: async () => { throw new Error('Unexpected bytes'); } };
    const host = createRegistryHostV1({ host: 'web', http, readSources: async () => sources });
    const listed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'agent', sourceIds: [source.id],
    }));
    expect(listed.pages[0]?.items).toMatchObject([
      { kind: 'agent', itemId: 'goose', flags: { pick: true } },
      { kind: 'plugin', itemId: agent.entry.pluginId, version: newer.version, flags: { pick: true } },
    ]);
    expect(listed.pages[0]?.items).toHaveLength(2);
    const read = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'plugin', sourceId: source.id, itemId: agent.entry.pluginId, version: agent.version,
    }));
    expect(RegistryItemV1Schema.parse(JSON.parse(JSON.stringify(read.item))).payload).toMatchObject({ kind: 'plugin', listing: curatedAgent });
    catalog.picks = [];
    expect(await host.execute('registries.sources.list', { kind: 'agent' })).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ id: source.id })]) });
    const agentRead = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'agent', sourceId: source.id, itemId: agent.entry.pluginId, version: agent.version,
    }));
    expect(agentRead.item.payload).toMatchObject({ kind: 'plugin', listing: curatedAgent });
    await expect(host.execute('registries.items.read', { kind: 'agent', sourceId: source.id, itemId: other.entry.pluginId,
      version: other.version })).rejects.toMatchObject({ status: { state: 'invalid_source' } });
  });

  it('exposes existing plugin-only Account catalogs to Agent browsing without changing stored kinds', async () => {
    const agent = publishedPlugin(true), other = publishedPlugin(false);
    const url = 'https://catalog.example/plugins.json';
    const storedSource = { id: deriveMarketplaceSourceId(url), title: 'Team plugins', url, format: 'happier-catalog' as const,
      kinds: ['plugin' as const], enabled: true, addedAt: 0 };
    const sources = listRegistrySourcesV1({ record: { v: 2, sources: [storedSource], disabledSourceIds: [] }, pluginSources: [] });
    const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({ source: { id: storedSource.id, title: storedSource.title, sourceUrl: url, kind: 'user' },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [agent.entry, other.entry], diagnostics: [] });
    const http: RegistryHttpV1 = { getJson: async request => request === url ? { ok: true, fetchedAt: 1, value: catalog }
      : { ok: false, status: { state: 'unreachable' } }, getText: async () => { throw new Error('Unexpected text'); },
      getBytes: async () => { throw new Error('Unexpected bytes'); } };
    const host = createRegistryHostV1({ host: 'web', http, readSources: async () => sources });
    expect(await host.execute('registries.sources.list', { kind: 'agent' })).toMatchObject({
      sources: expect.arrayContaining([expect.objectContaining({ id: storedSource.id, kinds: ['plugin', 'agent'] })]),
    });
    expect(storedSource.kinds).toEqual(['plugin']);
    expect(await host.execute('registries.sources.detect', { url })).toMatchObject({ detected: { kinds: ['plugin', 'agent'] } });
    const page = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
      kind: 'agent', sourceIds: [storedSource.id], query: 'Community',
    }));
    expect(page.pages[0]?.items).toMatchObject([{ kind: 'plugin', itemId: agent.entry.pluginId }]);
    expect(page.pages[0]?.items).toHaveLength(1);
    const { item } = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read', {
      kind: 'agent', sourceId: storedSource.id, itemId: agent.entry.pluginId, version: agent.version,
    }));
    expect(item.payload).toMatchObject({ kind: 'plugin', listing: agent.entry });
  });
});
