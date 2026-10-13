import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE,
  DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
  deriveMarketplaceSourceId,
  MarketplaceIndexEntryV1Schema,
  MarketplaceIndexSourceSnapshotV1Schema,
} from '@happier-dev/protocol';

const defaultWebsiteRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultPublicDir = fileURLToPath(new URL('../public', import.meta.url));

function sortEntries(entries) {
  return [...entries].sort((a, b) => (
    String(a.pluginId).localeCompare(String(b.pluginId))
    || String(a.distribution?.packageName ?? '').localeCompare(String(b.distribution?.packageName ?? ''))
    || String(a.distribution?.version ?? '').localeCompare(String(b.distribution?.version ?? ''))
  ));
}

export async function generateMarketplaceCatalog({
  publicDir = defaultPublicDir,
  websiteRoot = defaultWebsiteRoot,
} = {}) {
  const sourcePath = join(websiteRoot, 'marketplace', 'catalog.source.json');
  const raw = await readFile(sourcePath, 'utf8');
  const source = JSON.parse(raw);
  if (!source || typeof source !== 'object' || !Array.isArray(source.entries)) {
    throw new Error('Marketplace catalog source must contain an entries array');
  }
  // Offline validation only: every entry must already be an exact curated
  // listing (approved review, exact semver, complete SRI, manifest digest).
  // Approving a release entry requires separately checking the same facts
  // against live npm metadata and its tarball; ordinary builds never touch
  // the network or manufacture publication evidence.
  const entries = sortEntries(source.entries).map((entry) => {
    const parsed = MarketplaceIndexEntryV1Schema.parse(entry);
    if (parsed.review.status !== 'approved') {
      throw new Error(`Curated marketplace entry ${parsed.pluginId} must carry an approved review`);
    }
    if (parsed.distribution.registryProfileId !== undefined) {
      throw new Error(`Curated marketplace entry ${parsed.pluginId} must name a public npm coordinate`);
    }
    return parsed;
  });
  const snapshot = MarketplaceIndexSourceSnapshotV1Schema.parse({
    source: {
      id: deriveMarketplaceSourceId(DEFAULT_CURATED_MARKETPLACE_SOURCE_URL),
      title: DEFAULT_CURATED_MARKETPLACE_SOURCE_TITLE,
      kind: 'curated',
      sourceUrl: DEFAULT_CURATED_MARKETPLACE_SOURCE_URL,
    },
    freshness: { state: 'fresh', fetchedAtMs: null },
    entries,
    picks: source.picks ?? [],
    diagnostics: [],
  });
  const outputPath = join(publicDir, 'catalog.json');
  await mkdir(publicDir, { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return outputPath;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await generateMarketplaceCatalog();
}
