import type { MarketplaceIndexEntryV1, PluginUpdatePolicyV1 } from '@happier-dev/protocol/marketplace';
import { decideMarketplaceListingReviewV1 } from '@happier-dev/protocol/marketplace';
import { RegistryItemV1Schema, type RegistryItemV1, type RegistryListPageV1, type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { describeRegistrySourceStatus } from '@/registries/describeRegistrySourceStatus';

export type PluginMarketplaceCatalogSourceKind = 'curated' | 'community-npm' | 'user';
export type PluginMarketplaceSourceFreshness = 'fresh' | 'stale' | 'stale-offline' | 'unavailable' | 'auth-unavailable' | 'corrupt';
export type PluginMarketplaceCatalogEntry = Readonly<{
    id: string; sourceId: string; sourceKind: PluginMarketplaceCatalogSourceKind; sourceTitle: string;
    reviewStatus: 'approved' | 'withdrawn' | 'blocked' | 'unreviewed'; updatePolicy: PluginUpdatePolicyV1;
    publisher: MarketplaceIndexEntryV1['publisher']; categories: MarketplaceIndexEntryV1['categories'];
    contributions: MarketplaceIndexEntryV1['summary']['contributions']; links: MarketplaceIndexEntryV1['links'];
    executableRealms: MarketplaceIndexEntryV1['summary']['executableRealms'];
    platforms: MarketplaceIndexEntryV1['compatibility']['platforms'];
    title: string; description: string | null; version: string | null; packageName: string;
    /** Published review eligibility only. Chosen-machine install admission stays with the daemon. */
    installable: boolean; registrySelectionOrigin: string | null; warning?: 'withdrawn' | 'unreviewed';
}>;
export type PluginMarketplaceDiscoverDiagnostic = Readonly<{
    id: string; sourceId: string | null; sourceTitle: string | null; code: string; message: string;
}>;
export type PluginMarketplaceDiscoverSourceStatus = Readonly<{
    id: string; title: string; kind: PluginMarketplaceCatalogSourceKind; freshness: PluginMarketplaceSourceFreshness;
    diagnostics: readonly PluginMarketplaceDiscoverDiagnostic[];
}>;
export type PluginMarketplaceNonInstallableListing = Readonly<{
    pluginId: string; title: string; sourceId: string; sourceTitle: string;
    reason: 'sourceStale' | 'artifactUnavailable' | 'notApproved' | 'unsupportedSourceKind';
}>;
export type PluginMarketplaceDiscoverPage = Readonly<{
    /** Retained view-model paging demand; actual cursors remain source-owned Registry pages. */
    nextCursor: string | null; entries: readonly PluginMarketplaceCatalogEntry[];
    sources: readonly PluginMarketplaceDiscoverSourceStatus[];
    diagnostics: readonly PluginMarketplaceDiscoverDiagnostic[];
    nonInstallable: readonly PluginMarketplaceNonInstallableListing[];
}>;

export function registryPluginSourceKind(source: RegistrySourceDescriptorV1): PluginMarketplaceCatalogSourceKind {
    return source.format === 'happier-npm' ? 'community-npm' : source.origin.kind === 'built_in' ? 'curated' : 'user';
}

/** Published Registry metadata into the retained Discover presentation, with no machine facts. */
export function projectRegistryMarketplacePage(input: Readonly<{
    items: readonly RegistryItemV1[]; pages: readonly RegistryListPageV1[]; sources: readonly RegistrySourceDescriptorV1[];
}>): PluginMarketplaceDiscoverPage {
    const entries: PluginMarketplaceCatalogEntry[] = [], nonInstallable: PluginMarketplaceNonInstallableListing[] = [];
    for (const raw of input.items) {
        const item = RegistryItemV1Schema.parse(raw);
        if (item.payload.kind !== 'plugin') throw new Error('registry_plugin_payload_required');
        const { listing, source } = item.payload;
        const decision = decideMarketplaceListingReviewV1({ source, review: listing.review });
        const withdrawn = !decision.installable && decision.block === 'curated-review-withdrawn';
        if (!decision.installable && !withdrawn) {
            nonInstallable.push({ pluginId: listing.pluginId, title: listing.display.title, sourceId: source.id,
                sourceTitle: source.title, reason: decision.block === 'unsupported-source-kind' ? 'unsupportedSourceKind' : 'notApproved' });
            continue;
        }
        entries.push({ id: listing.pluginId, sourceId: source.id, sourceKind: source.kind, sourceTitle: source.title,
            reviewStatus: listing.review.status, updatePolicy: listing.updatePolicy, publisher: listing.publisher,
            categories: listing.categories, contributions: listing.summary.contributions, links: listing.links,
            executableRealms: listing.summary.executableRealms, platforms: listing.compatibility.platforms,
            title: listing.display.title, description: listing.display.description, version: listing.distribution.version,
            packageName: listing.distribution.packageName, installable: decision.installable, registrySelectionOrigin: null,
            ...(withdrawn ? { warning: 'withdrawn' as const } : source.kind !== 'curated' && listing.review.status === 'unreviewed'
                ? { warning: 'unreviewed' as const } : {}) });
    }
    const sources = input.pages.map(page => {
        const source = input.sources.find(source => source.id === page.sourceId);
        const title = source?.title ?? page.sourceId;
        const diagnostics = page.status.state === 'ok' ? [] : [{ id: 'source:' + encodeURIComponent(page.sourceId) + ':' + page.status.state,
            sourceId: page.sourceId, sourceTitle: title, code: page.status.state, message: describeRegistrySourceStatus(page.status) }];
        const freshness: PluginMarketplaceSourceFreshness = page.status.state === 'ok' ? 'fresh'
            : page.status.state === 'auth_failed' ? 'auth-unavailable'
                : page.status.state === 'invalid_source' || page.status.state === 'newer_format' ? 'corrupt' : 'unavailable';
        return { id: page.sourceId, title, kind: source ? registryPluginSourceKind(source) : 'user' as const, freshness, diagnostics };
    });
    return { entries, sources, diagnostics: sources.flatMap(source => source.diagnostics), nonInstallable,
        nextCursor: input.pages.some(page => page.nextCursor !== null) ? 'more' : null };
}

/** One listing's identity for the paged list: a plugin per source it was found in. */
function discoverListingKey(sourceId: string, pluginId: string): string {
    // Length-prefixed so the pair is unambiguous whatever characters a
    // source id or listing id contains, without an unprintable separator.
    return `${sourceId.length}:${sourceId}:${pluginId}`;
}

function discoverEntryKey(entry: PluginMarketplaceCatalogEntry): string {
    return discoverListingKey(entry.sourceId, entry.id);
}

function discoverNonInstallableKey(entry: PluginMarketplaceNonInstallableListing): string {
    return discoverListingKey(entry.sourceId, entry.pluginId);
}

function mergeDiscoverListings<T>(
    previous: readonly T[],
    next: readonly T[],
    keyOf: (entry: T) => string,
): readonly T[] {
    const seen = new Set(previous.map(keyOf));
    const added = next.filter((entry) => {
        const key = keyOf(entry);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    return added.length === 0 ? previous : [...previous, ...added];
}

/**
 * Appends the next cursor page to the list already on screen.
 *
 * Aggregate paging over several indexes can legitimately repeat a listing
 * across page boundaries, so the merge is idempotent on the listing identity
 * and preserves first-seen order. It returns the previous array unchanged when
 * a page adds nothing, so an unchanged list keeps its reference.
 */
export function mergeDiscoverEntries(
    previous: readonly PluginMarketplaceCatalogEntry[],
    next: readonly PluginMarketplaceCatalogEntry[],
): readonly PluginMarketplaceCatalogEntry[] {
    return mergeDiscoverListings(previous, next, discoverEntryKey);
}

/** Deduplicates one freshly acquired page against itself. */
export function dedupeDiscoverEntries(
    entries: readonly PluginMarketplaceCatalogEntry[],
): readonly PluginMarketplaceCatalogEntry[] {
    return mergeDiscoverEntries([], entries);
}

export function mergeDiscoverNonInstallableListings(
    previous: readonly PluginMarketplaceNonInstallableListing[],
    next: readonly PluginMarketplaceNonInstallableListing[],
): readonly PluginMarketplaceNonInstallableListing[] {
    return mergeDiscoverListings(previous, next, discoverNonInstallableKey);
}
