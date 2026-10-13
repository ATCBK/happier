import { describe, expect, it } from 'vitest';
import { MarketplaceIndexEntryV1Schema, type MarketplaceIndexEntryV1 } from '@happier-dev/protocol/marketplace';
import { RegistryItemV1Schema, RegistryListPageV1Schema, RegistrySourceDescriptorV1Schema,
    type RegistryItemV1, type RegistryListPageV1 } from '@happier-dev/protocol/registries';
import { mergeDiscoverEntries, mergeDiscoverNonInstallableListings, projectRegistryMarketplacePage } from './readPluginMarketplaceCatalog';

type Source = Extract<RegistryItemV1['payload'], { kind: 'plugin' }>['source'];
const curated: Source = { id: 'marketplace:curated', title: 'Happier curated', kind: 'curated',
    sourceUrl: 'https://marketplace.example.test/index.json' };
const community: Source = { id: 'marketplace:community-npm', title: 'Community npm', kind: 'community-npm',
    sourceUrl: 'https://registry.npmjs.org' };
const internal: Source = { id: 'marketplace:internal', title: 'Internal index', kind: 'user',
    sourceUrl: 'https://internal.example.test/index.json' };

function sourceDescriptor(source: Source) {
    return RegistrySourceDescriptorV1Schema.parse({ id: source.id, title: source.title, url: source.sourceUrl,
        format: source.kind === 'community-npm' ? 'happier-npm' : 'happier-catalog', kinds: ['plugin'],
        enabled: true, addedAt: 1, origin: { kind: source.kind === 'user' ? 'user' : 'built_in' }, removable: source.kind === 'user' });
}
function registryItem(overrides: Partial<MarketplaceIndexEntryV1> = {}, source: Source = curated) {
    const listing = MarketplaceIndexEntryV1Schema.parse({
        pluginId: 'sample.plugin', publisher: { id: 'sample', displayName: 'Sample' },
        display: { title: 'Sample Plugin', description: 'Marketplace listing' },
        distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: 'sample-plugin', version: '1.2.3',
            integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
        manifestDigest: 'sha256:' + 'a'.repeat(64), compatibility: { happier: '>=1', platforms: ['web'] },
        summary: { contributions: ['agents'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
        review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' }, categories: ['agents'], media: [], updatePolicy: 'allowed', links: {},
        ...overrides,
    });
    return RegistryItemV1Schema.parse({ summary: { sourceId: source.id, kind: 'plugin', itemId: source.kind === 'community-npm' ? listing.distribution.packageName : listing.pluginId,
        title: listing.display.title, version: listing.distribution.version }, payload: { kind: 'plugin', listing, source }, fetchedAt: 1 });
}
function page(items: readonly RegistryItemV1[], pages?: readonly RegistryListPageV1[], sources: readonly Source[] = [curated]) {
    return projectRegistryMarketplacePage({ items, sources: sources.map(sourceDescriptor),
        pages: pages ?? sources.map(source => RegistryListPageV1Schema.parse({ sourceId: source.id,
            status: { state: 'ok', fetchedAt: 1 }, items: items.filter(item => item.summary.sourceId === source.id).map(item => item.summary), nextCursor: null })) });
}

describe('projectRegistryMarketplacePage', () => {
    it('projects the pinned listing and its published install coordinate without machine admission facts', () => {
        const projected = page([registryItem({ links: { homepage: 'https://example.test/plugin', repository: 'https://example.test/source', support: null },
            summary: { contributions: ['agents', 'tools'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] } })]);
        expect(projected.entries).toEqual([expect.objectContaining({ id: 'sample.plugin', sourceId: curated.id, sourceKind: 'curated',
            title: 'Sample Plugin', version: '1.2.3', packageName: 'sample-plugin', installable: true, registrySelectionOrigin: null,
            contributions: ['agents', 'tools'], links: { homepage: 'https://example.test/plugin', repository: 'https://example.test/source', support: null } })]);
        expect(projected.nonInstallable).toEqual([]);
    });
    it('keeps a pinned curated listing installable without advertising an update', () => {
        expect(page([registryItem({ updatePolicy: 'pinned' })]).entries[0]).toMatchObject({ updatePolicy: 'pinned', installable: true });
    });
    it.each([community, internal])('offers unreviewed code from $title to the daemon install review', source => {
        const item = registryItem({ review: { status: 'unreviewed', reviewedAt: null } }, source);
        const projected = page([item], undefined, [source]);
        expect(projected.entries[0]).toMatchObject({ sourceId: source.id, installable: true, warning: 'unreviewed', registrySelectionOrigin: null });
        expect(projected.nonInstallable).toEqual([]);
    });
    it('keeps a withdrawn curated listing visible as a warning without granting install authority', () => {
        const projected = page([registryItem({ review: { status: 'withdrawn', reviewedAt: null } })]);
        expect(projected.entries[0]).toMatchObject({ id: 'sample.plugin', warning: 'withdrawn', installable: false });
        expect(projected.nonInstallable).toEqual([]);
    });
    it('refuses a blocked curated listing through the canonical review decision', () => {
        const projected = page([registryItem({ review: { status: 'blocked', reviewedAt: null } })]);
        expect(projected.entries).toEqual([]);
        expect(projected.nonInstallable).toEqual([expect.objectContaining({ pluginId: 'sample.plugin', sourceId: curated.id, reason: 'notApproved' })]);
    });
    it('keeps a healthy source visible while a second source fails and preserves paging demand', () => {
        const item = registryItem();
        const pages = [RegistryListPageV1Schema.parse({ sourceId: curated.id, status: { state: 'ok', fetchedAt: 1 },
            items: [item.summary], nextCursor: 'curated-next' }), RegistryListPageV1Schema.parse({ sourceId: internal.id,
            status: { state: 'auth_failed' }, items: [], nextCursor: null })];
        const projected = page([item], pages, [curated, internal]);
        expect(projected.entries).toHaveLength(1);
        expect(projected.nextCursor).not.toBeNull();
        expect(projected.sources.find(source => source.id === internal.id)).toMatchObject({ title: internal.title });
        expect(projected.sources.find(source => source.id === internal.id)?.diagnostics).not.toEqual([]);
    });
});

describe('marketplace listing merges', () => {
    it('appends new identities, keeps the same plugin once per source and retains unchanged list identity', () => {
        const first = page([registryItem({ pluginId: 'shared.plugin' })]).entries;
        const following = page([registryItem({ pluginId: 'shared.plugin', review: { status: 'unreviewed', reviewedAt: null } }, community)], undefined, [community]).entries;
        expect(mergeDiscoverEntries(first, following).map(entry => entry.sourceId)).toEqual([curated.id, community.id]);
        expect(mergeDiscoverEntries(first, first)).toBe(first);
        const blocked = page([registryItem({ review: { status: 'blocked', reviewedAt: null } })]).nonInstallable;
        expect(mergeDiscoverNonInstallableListings(blocked, blocked)).toBe(blocked);
    });
});
