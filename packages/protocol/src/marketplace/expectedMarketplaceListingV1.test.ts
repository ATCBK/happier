import { describe, expect, it } from 'vitest';

import { ExpectedMarketplaceListingV1Schema, projectExpectedMarketplaceListing } from './expectedMarketplaceListingV1.js';
import { MarketplaceIndexEntryV1Schema, MarketplaceIndexSourceSnapshotV1Schema } from './marketplaceIndexV1.js';

const INTEGRITY = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
const MANIFEST_DIGEST = `sha256:${'a'.repeat(64)}`;

const UNREVIEWED_SOURCES = [
  { id: 'marketplace:community-npm', kind: 'community-npm', sourceUrl: 'https://registry.example/-/v1/search' },
  { id: 'team_catalog', kind: 'user', sourceUrl: 'https://catalog.example/index.json' },
] as const;

function unreviewedExpectedListing(
  source: (typeof UNREVIEWED_SOURCES)[number],
  updatePolicy: 'pinned' | 'allowed',
) {
  return {
    source: { ...source },
    pluginId: 'acme.plugin',
    publisher: { id: 'acme', displayName: 'Acme' },
    packageName: '@acme/plugin',
    registryOrigin: 'https://registry.example',
    version: '1.0.0',
    integrity: INTEGRITY,
    manifestDigest: MANIFEST_DIGEST,
    review: { status: 'unreviewed', reviewedAt: null },
    updatePolicy,
  };
}

describe('ExpectedMarketplaceListingV1', () => {
  it('projects pure catalog facts into the exact strict install commitment without machine admission or credential facts', () => {
    const listing = MarketplaceIndexEntryV1Schema.parse({
      pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' },
      display: { title: 'Acme', description: null },
      distribution: { kind: 'npm', packageName: '@acme/plugin', registryOrigin: 'https://registry.example',
        registryProfileId: 'catalog_profile', version: '1.0.0', integrity: INTEGRITY },
      manifestDigest: MANIFEST_DIGEST, compatibility: { platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: [] },
      review: { status: 'unreviewed', reviewedAt: null }, updatePolicy: 'allowed', categories: [], media: [], links: {},
    });
    const source = MarketplaceIndexSourceSnapshotV1Schema.shape.source.parse({ ...UNREVIEWED_SOURCES[1], title: 'Acme catalog' });
    const commitment = ExpectedMarketplaceListingV1Schema.parse(projectExpectedMarketplaceListing({ ...listing, source }, null));
    expect(commitment).toEqual(unreviewedExpectedListing(UNREVIEWED_SOURCES[1], 'allowed'));
    expect(commitment).not.toHaveProperty('registryProfileId');
  });

  it('carries every declared unreviewed update policy exactly, for community npm and user sources alike', () => {
    for (const source of UNREVIEWED_SOURCES) {
      for (const updatePolicy of ['pinned', 'allowed'] as const) {
        const result = ExpectedMarketplaceListingV1Schema.safeParse(unreviewedExpectedListing(source, updatePolicy));
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.updatePolicy).toBe(updatePolicy);
        }
      }
    }
  });

  it('still refuses an unreviewed source that claims a curated approval or a retired policy alias', () => {
    for (const source of UNREVIEWED_SOURCES) {
      expect(ExpectedMarketplaceListingV1Schema.safeParse({
        ...unreviewedExpectedListing(source, 'allowed'),
        review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' },
      }).success).toBe(false);
      expect(ExpectedMarketplaceListingV1Schema.safeParse({
        ...unreviewedExpectedListing(source, 'automatic'),
      }).success).toBe(false);
    }
  });

  it.each(['withdrawn', 'blocked'] as const)('refuses to synthesize approval for a %s curated listing', status => {
    const listing = MarketplaceIndexEntryV1Schema.parse({
      pluginId: 'acme.plugin', publisher: { id: 'acme', displayName: 'Acme' }, display: { title: 'Acme', description: null },
      distribution: { kind: 'npm', packageName: '@acme/plugin', registryOrigin: 'https://registry.example',
        version: '1.0.0', integrity: INTEGRITY },
      manifestDigest: MANIFEST_DIGEST, compatibility: { platforms: ['linux'] },
      summary: { contributions: [], requiredHostAccess: [], optionalHostAccess: [], executableRealms: [] },
      review: { status, reviewedAt: '2026-07-13T00:00:00.000Z' }, updatePolicy: 'pinned', categories: [], media: [], links: {},
    });
    const source = MarketplaceIndexSourceSnapshotV1Schema.shape.source.parse({ id: 'curated', title: 'Curated', kind: 'curated',
      sourceUrl: 'https://catalog.example/index.json' });
    expect(() => projectExpectedMarketplaceListing({ ...listing, source }, null)).toThrow();
  });
});
