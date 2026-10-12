// CLOSEOUT20 independent-checker scratch: deleted after the run. Shows what
// the creator's launch-time marketplace query (`text: ''`, `limit: 1`,
// `filters.pluginIds`, no `sourceIds`) asks a community-npm source for.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createMarketplaceIndexService, COMMUNITY_NPM_MARKETPLACE_SOURCE } from './service';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('CLOSEOUT20 creator query shape against the community npm source', () => {
  it('records the source request the creator query produces', async () => {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'closeout20-query-'));
    roots.push(happyHomeDir);
    const requests: unknown[] = [];
    const service = createMarketplaceIndexService({
      happyHomeDir,
      loadSource: async (params) => {
        requests.push({ sourceId: params.source.id, kind: params.source.kind, query: params.query });
        return {
          source: { id: params.source.id, title: params.source.title, kind: params.source.kind, sourceUrl: params.source.sourceUrl },
          freshness: { state: 'fresh', fetchedAtMs: 1 },
          diagnostics: [],
          entries: [],
        };
      },
    });
    // Exactly the creator's query from temporaryComputerCreatorDependencies.ts.
    const result = await service.query({
      text: '', cursor: null, limit: 1, filters: { pluginIds: ['acme.sample'], includeUnavailable: true },
    });
    console.log('CREATOR_QUERY_SOURCE_REQUESTS', JSON.stringify(requests));
    console.log('CREATOR_QUERY_RESULT_SOURCES', JSON.stringify(result.sources.map((s) => s.source.id)));
    const community = requests.find((r) => (r as { sourceId: string }).sourceId === COMMUNITY_NPM_MARKETPLACE_SOURCE.id) as { query: Record<string, unknown> } | undefined;
    expect(community).toBeDefined();
    // The community npm request carries neither the plugin id nor a package name.
    expect(JSON.stringify(community!.query)).not.toContain('acme.sample');

    // The daemon's own exact path, for comparison.
    requests.length = 0;
    await service.queryExactListing({ sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE.id, pluginId: 'acme.sample', packageName: '@acme/sample' });
    console.log('DAEMON_EXACT_SOURCE_REQUESTS', JSON.stringify(requests));
  });
});
