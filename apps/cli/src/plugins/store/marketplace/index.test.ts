import { describe, expect, it } from 'vitest';

import type { MarketplaceIndexSourceSnapshotV1 } from '@happier-dev/protocol';

import { createExactMarketplaceIndex } from './index';
import { projectMarketplaceArtifactAccess } from './service';

const entry = (pluginId: string, packageName: string, status: 'approved' | 'withdrawn' | 'blocked' = 'approved'): MarketplaceIndexSourceSnapshotV1['entries'][number] => ({
  pluginId,
  publisher: { id: 'acme', displayName: 'Acme' },
  display: { title: pluginId, description: `${pluginId} description` },
  distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName, version: '1.0.0', integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
  manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  compatibility: { happier: '>=1.0.0', platforms: ['darwin', 'linux'] },
  summary: { contributions: ['agents'], requiredHostAccess: ['process'], optionalHostAccess: [], executableRealms: ['daemon'] },
  review: { status, reviewedAt: '2026-07-13T00:00:00.000Z' },
  categories: ['agents'], media: [], updatePolicy: 'allowed', links: { homepage: 'https://example.com/plugin' },
});

const source = (id: string, kind: 'curated' | 'user' | 'community-npm', entries: MarketplaceIndexSourceSnapshotV1['entries'], freshness: MarketplaceIndexSourceSnapshotV1['freshness'] = { state: 'fresh', fetchedAtMs: 100 }): MarketplaceIndexSourceSnapshotV1 => ({
  source: { id, title: id, kind, sourceUrl: kind === 'community-npm' ? 'https://registry.npmjs.org/-/v1/search' : `https://catalog.example/${id}.json` },
  freshness,
  entries,
  picks: [],
  diagnostics: [],
});

describe('exact marketplace review projection',()=>{
  it('targets one plugin and keeps catalog-selected profiles unverified without mutating installed trust',()=>{
    const selected={...entry('acme.private','@acme/private'),distribution:{...entry('acme.private','@acme/private').distribution,registryProfileId:'catalog-controlled'}};
    const result=createExactMarketplaceIndex({source:source('curated','curated',[entry('acme.other','@acme/other'),selected]),pluginId:'acme.private'});
    expect(result.nextCursor).toBeNull();expect(result.items).toHaveLength(1);
    const item=projectMarketplaceArtifactAccess(result.items[0]!,[{profileId:'catalog-controlled',origin:'https://registry.npmjs.org',availability:'available'}]);
    expect(item.artifactAccess).toEqual({state:'unverified-profile',registryProfileId:'catalog-controlled'});
    expect(item.admission).toEqual({install:'full-review',mutatesInstalledTrust:false,disablesInstalledCode:false,directNpmRequiresFullReview:true});
    expect(createExactMarketplaceIndex({source:source('curated','curated',[selected]),pluginId:'acme.missing'}).items).toEqual([]);
  });
  it.each(['approved','withdrawn','blocked'] as const)('preserves %s curation as discovery truth, never installed trust',status=>{
    const result=createExactMarketplaceIndex({source:source('curated','curated',[{...entry('acme.agent','@acme/agent',status),updatePolicy:'pinned'}]),pluginId:'acme.agent'});
    expect(result.items[0]).toMatchObject({review:{status},updatePolicy:'pinned',admission:{install:'full-review',mutatesInstalledTrust:false,disablesInstalledCode:false}});
  });
  it('retains stale-offline truth for the exact-install availability decision',()=>{
    const result=createExactMarketplaceIndex({source:source('curated','curated',[entry('acme.agent','@acme/agent')],{state:'stale-offline',fetchedAtMs:100,staleSinceMs:200}),pluginId:'acme.agent'});
    expect(result.items[0]?.freshness.state).toBe('stale-offline');
  });
  it('rejects conflicting exact release metadata and keeps the deterministic latest release',()=>{
    const original=entry('acme.agent','@acme/agent');
    const conflict={...original,distribution:{...original.distribution,integrity:'sha512-AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=='}};
    const rejected=createExactMarketplaceIndex({source:source('curated','curated',[original,conflict]),pluginId:'acme.agent'});
    expect(rejected.items).toHaveLength(1);
    expect(rejected.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:'marketplace_distribution_metadata_conflict'})]));
    const latest=createExactMarketplaceIndex({source:source('curated','curated',[original,{...original,distribution:{...original.distribution,version:'10.0.0'}}]),pluginId:'acme.agent'});
    expect(latest.items[0]?.distribution.version).toBe('10.0.0');
  });
  it('preserves every same-source rebinding diagnostic rather than silently replacing distribution',()=>{
    const canonical=entry('acme.agent','@acme/agent');
    const conflicts=Array.from({length:200},(_,index)=>({...canonical,distribution:{...canonical.distribution,packageName:'@attacker/rebound-'+index}}));
    const result=createExactMarketplaceIndex({source:source('curated','curated',conflicts),pluginId:'acme.agent'});
    expect(result.items).toHaveLength(1);expect(result.diagnostics).toHaveLength(199);
    expect(result.diagnostics.every(diagnostic=>diagnostic.code==='marketplace_distribution_rebinding')).toBe(true);
  });
});
