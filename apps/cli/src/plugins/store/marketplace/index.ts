import { MarketplaceIndexQueryResultV1Schema, MarketplaceIndexSourceSnapshotV1Schema } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';
import { readMarketplaceSourceListingsV1 } from '@happier-dev/protocol/marketplace';
import type { MarketplaceIndexQueryResultV1, MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';

/** The exact review projection; registry adapters own every browsing page. */
export function createExactMarketplaceIndex(input: Readonly<{
  source: MarketplaceIndexSourceSnapshotV1;
  pluginId: string;
  version?: string;
}>): MarketplaceIndexQueryResultV1 {
  const snapshot = MarketplaceIndexSourceSnapshotV1Schema.parse(input.source);
  const normalized = readMarketplaceSourceListingsV1(snapshot,
    input.version !== undefined ? { pluginId: input.pluginId, version: input.version } : undefined);
  const entry = normalized.entries.find(item => item.pluginId === input.pluginId);
  return MarketplaceIndexQueryResultV1Schema.parse({
    revision: 0, nextCursor: null,
    items: entry ? [{ ...entry, source: snapshot.source, freshness: snapshot.freshness,
      admission: { install: 'full-review', mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
      artifactAccess: entry.distribution.registryProfileId
        ? { state: 'unverified-profile', registryProfileId: entry.distribution.registryProfileId }
        : { state: 'public', registryProfileId: null },
    }] : [],
    sources: [{ source: snapshot.source, freshness: snapshot.freshness, diagnostics: snapshot.diagnostics }],
    diagnostics: normalized.diagnostics,
  });
}
