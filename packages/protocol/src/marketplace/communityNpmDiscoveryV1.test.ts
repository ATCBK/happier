import { describe, expect, it } from 'vitest';

import { createPluginCompatibilityProjectionV1 } from '../plugins/availability/v1.js';
import {
  createMarketplaceNpmDiscoveryProjectionV1,
  MarketplaceIndexEntryV1Schema,
} from './marketplaceIndexV1.js';
import {
  buildCommunityNpmSearchUrlV1,
  projectCommunityNpmListingV1,
  readCommunityNpmPackumentVersionV1,
  readCommunityNpmSearchV1,
} from './communityNpmDiscoveryV1.js';

const registryOrigin = 'https://registry.npmjs.org';
const packageName = '@acme/community';
const version = '1.0.0';
const integrity = 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==';
const publisher = { id: 'acme', displayName: 'acme' };

// The same packed manifest facts exercised by the daemon loader, emitted by
// the canonical compatibility and npm-discovery producers rather than copied.
function publishedVersionMetadata() {
  const compatibilityProjection = createPluginCompatibilityProjectionV1({
    manifest: {
      schemaVersion: 2,
      id: 'acme.community',
      version,
      displayName: 'Community',
      engines: { happier: '>=0.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/index.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {},
    },
    uiArtifacts: { version: 2, entries: [] },
  });
  return {
    name: packageName,
    version,
    dist: { integrity, tarball: `${registryOrigin}/community.tgz` },
    happier: {
      compatibilityProjection,
      marketplaceDiscovery: createMarketplaceNpmDiscoveryProjectionV1({
        compatibility: compatibilityProjection,
        manifestDigest: `sha256:${'a'.repeat(64)}`,
      }),
    },
  };
}

describe('community npm discovery protocol owner', () => {
  it('keeps the ecosystem qualifier and preserves the query and processing window', () => {
    const text = 'terminal themes '.repeat(100).trim();
    const url = new URL(buildCommunityNpmSearchUrlV1(registryOrigin, { text, from: 40, size: 20 }));
    expect(url.pathname).toBe('/-/v1/search');
    expect(url.searchParams.get('text')).toBe(`keywords:happier-plugin ${text}`);
    expect(url.searchParams.get('from')).toBe('40');
    expect(url.searchParams.get('size')).toBe('20');
    const exact = new URL(buildCommunityNpmSearchUrlV1(registryOrigin, { text, exactPackageName: packageName, from: 40 }));
    expect(exact.searchParams.get('text')).toBe(`keywords:happier-plugin ${packageName}`);
    expect(exact.searchParams.get('from')).toBe('0');
  });

  it('filters an exact package before applying the metadata window and retains npm total', () => {
    const names = ['@acme/neighbour', packageName, '@acme/other'];
    const raw = { total: 240, objects: names.map((name) => ({ package: { name, version, publisher: { username: 'acme' } } })) };
    expect(readCommunityNpmSearchV1(raw, { exactPackageName: packageName, from: 0, size: 1 })).toEqual({
      total: 240, candidates: [{ packageName, version, publisher }],
    });
    expect(readCommunityNpmSearchV1(raw, { from: 40, size: 2 }).candidates.map((item) => item.packageName)).toEqual(names.slice(0, 2));
  });

  it('projects published metadata through the exact strict listing consumer', () => {
    const outcome = projectCommunityNpmListingV1({ versionMetadata: publishedVersionMetadata(), packageName, version, integrity, registryOrigin, publisher });
    expect(outcome.status).toBe('listed');
    if (outcome.status !== 'listed') throw new Error('Expected the published package to be listed');
    expect(MarketplaceIndexEntryV1Schema.parse(outcome.entry)).toMatchObject({
      pluginId: 'acme.community', publisher,
      display: { title: 'Community', description: null },
      distribution: { kind: 'npm', registryOrigin, packageName, version, integrity },
      review: { status: 'unreviewed', reviewedAt: null }, updatePolicy: 'allowed',
    });
  });

  it('distinguishes unsupported discovery versions from contradictory published metadata', () => {
    const metadata = publishedVersionMetadata();
    const input = { versionMetadata: metadata, packageName, version, integrity, registryOrigin, publisher };
    expect(projectCommunityNpmListingV1({ ...input, versionMetadata: { ...metadata, happier: {
      ...metadata.happier, marketplaceDiscovery: { ...metadata.happier.marketplaceDiscovery, version: 2 },
    } } })).toEqual({ status: 'skipped', reason: 'unsupported-discovery-version' });
    expect(projectCommunityNpmListingV1({ ...input, versionMetadata: { ...metadata, happier: {
      ...metadata.happier, marketplaceDiscovery: { ...metadata.happier.marketplaceDiscovery, pluginId: 'acme.spoofed' },
    } } })).toEqual({ status: 'skipped', reason: 'unusable-metadata' });
  });

  it('admits only the requested package version and an HTTPS tarball on its selected origin', () => {
    const metadata = publishedVersionMetadata();
    const input = { packageName, version, registryOrigin };
    const packument = { name: packageName, versions: { [version]: metadata } };
    expect(readCommunityNpmPackumentVersionV1(packument, input)).toEqual({
      ok: true, versionMetadata: metadata, integrity, tarballUrl: `${registryOrigin}/community.tgz`,
    });
    expect(readCommunityNpmPackumentVersionV1({ ...packument, name: '@acme/other' }, input)).toEqual({ ok: false, reason: 'identity_mismatch' });
    expect(readCommunityNpmPackumentVersionV1({ ...packument, versions: { [version]: { ...metadata, version: '2.0.0' } } }, input)).toEqual({ ok: false, reason: 'identity_mismatch' });
    for (const tarball of ['https://other.example/community.tgz', 'http://registry.npmjs.org/community.tgz', 'https://user:password@registry.npmjs.org/community.tgz']) {
      expect(readCommunityNpmPackumentVersionV1({ ...packument, versions: { [version]: { ...metadata, dist: { ...metadata.dist, tarball } } } }, input)).toEqual({ ok: false, reason: 'dist_invalid' });
    }
  });
});
