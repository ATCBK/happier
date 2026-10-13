import { expect, it } from 'vitest';
import { MarketplaceIndexSourceSnapshotV1Schema } from '../../marketplace/marketplaceIndexV1.js';
import { deriveMarketplaceSourceId } from '../../marketplace/marketplaceSourceRegistryV1.js';
import { createPluginRegistrySourceDescriptorV1 } from '../registryPluginSourcesV1.js';
import { assertRegistryMarketplaceCatalogSourceV1, bindRegistryMarketplaceCatalogV1 } from './registryMarketplaceCatalogBindingV1.js';

it('binds only proven plugin declarations after validating the published catalog identity', () => {
  const source = createPluginRegistrySourceDescriptorV1({ pluginId: 'com.acme.sources', suppliers: ['supplier-a'],
    definition: { id: 'team', title: 'Team', format: 'happier-catalog', kinds: ['plugin'], url: 'https://catalog.example/plugins.json' } });
  const catalog = MarketplaceIndexSourceSnapshotV1Schema.parse({
    source: { id: deriveMarketplaceSourceId(source.url), title: 'Published catalog', sourceUrl: source.url, kind: 'user' },
    freshness: { state: 'fresh', fetchedAtMs: 1 }, entries: [], diagnostics: [],
  });
  expect(MarketplaceIndexSourceSnapshotV1Schema.parse(JSON.parse(JSON.stringify(bindRegistryMarketplaceCatalogV1(catalog, source)))).source)
    .toEqual({ ...catalog.source, id: source.id });
  expect(catalog.source.id).toBe(deriveMarketplaceSourceId(source.url));
  for (const invalid of [
    { ...source, origin: { kind: 'user' as const } },
    { ...source, origin: { ...source.origin, kind: 'plugin' as const, pluginId: 'com.other.sources', localId: 'team', suppliers: [] } },
    { ...source, id: 'com.acme.sources/another' },
    { ...source, id: 'com.acme.sources/team\n' },
  ]) {
    expect(() => assertRegistryMarketplaceCatalogSourceV1(invalid)).toThrow();
    expect(() => bindRegistryMarketplaceCatalogV1(catalog, invalid)).toThrow();
  }
  for (const invalid of [
    { ...catalog, source: { ...catalog.source, id: source.id } },
    { ...catalog, source: { ...catalog.source, sourceUrl: 'https://another.example/catalog.json' } },
    { ...catalog, source: { ...catalog.source, kind: 'curated' as const } },
  ]) expect(() => bindRegistryMarketplaceCatalogV1(invalid, source)).toThrow();
  const user = { ...source, id: catalog.source.id, origin: { kind: 'user' as const }, removable: true };
  expect(bindRegistryMarketplaceCatalogV1(catalog, user)).toEqual(catalog);
});
