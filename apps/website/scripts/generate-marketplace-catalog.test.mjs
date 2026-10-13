import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  deriveMarketplaceSourceId,
  MarketplaceIndexSourceSnapshotV1Schema,
} from '@happier-dev/protocol';

import { generateMarketplaceCatalog } from './generate-marketplace-catalog.mjs';

const websiteRoot = fileURLToPath(new URL('..', import.meta.url));
const CANONICAL_SOURCE_URL = 'https://marketplace.happier.dev/catalog.json';
const VALID_ENTRY = {
  pluginId: 'com.example.sample',
  publisher: { id: 'example', displayName: 'Example' },
  display: { title: 'Sample', description: 'A sample plugin' },
  distribution: {
    kind: 'npm',
    registryOrigin: 'https://registry.npmjs.org',
    packageName: '@example/happier-sample',
    version: '1.0.0',
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  },
  manifestDigest: `sha256:${'a'.repeat(64)}`,
  compatibility: { platforms: ['linux'] },
  summary: {
    contributions: [],
    requiredHostAccess: [],
    optionalHostAccess: [],
    executableRealms: ['daemon'],
  },
  review: { status: 'approved', reviewedAt: '2026-09-20T00:00:00.000Z' },
  categories: [],
  media: [],
  updatePolicy: 'allowed',
  links: {},
};

async function writeSource(root, entries, picks = []) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'marketplace'), { recursive: true });
  await writeFile(join(root, 'marketplace', 'catalog.source.json'), JSON.stringify({ entries, picks }), 'utf8');
}

test('emits validated curated registry pointers without copying their content', async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-picks-'));
  const publicDir = join(sourceDir, 'public');
  const picks = [{ kind: 'skill', format: 'git', sourceUrl: 'https://github.com/example/skills', itemId: '', path: 'review' }];
  try {
    await writeSource(sourceDir, [], picks);
    const output = JSON.parse(await readFile(await generateMarketplaceCatalog({ publicDir, websiteRoot: sourceDir }), 'utf8'));
    assert.deepEqual(MarketplaceIndexSourceSnapshotV1Schema.parse(output).picks, picks);
    await writeSource(sourceDir, [], [{ ...picks[0], kind: 'plugin' }]);
    await assert.rejects(() => generateMarketplaceCatalog({ publicDir, websiteRoot: sourceDir }));
  } finally { await rm(sourceDir, { recursive: true, force: true }); }
});

test('emits a deterministic strict curated snapshot bound to the canonical source identity', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-catalog-'));
  try {
    const outputPath = await generateMarketplaceCatalog({ publicDir });
    assert.equal(outputPath, join(publicDir, 'catalog.json'));
    const raw = await readFile(outputPath, 'utf8');
    const snapshot = MarketplaceIndexSourceSnapshotV1Schema.parse(JSON.parse(raw));
    assert.equal(snapshot.source.sourceUrl, CANONICAL_SOURCE_URL);
    assert.equal(snapshot.source.kind, 'curated');
    assert.equal(snapshot.source.id, deriveMarketplaceSourceId(CANONICAL_SOURCE_URL));
    assert.deepEqual(snapshot.entries, [], 'the source stays empty until an approved public npm release exists');
    // Deterministic bytes: a second generation from the same source input is identical.
    const secondPath = await generateMarketplaceCatalog({ publicDir });
    assert.equal(await readFile(secondPath, 'utf8'), raw);
  } finally {
    await rm(publicDir, { recursive: true, force: true });
  }
});

test('rejects unreviewed curated entries', async () => {
  const publicDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-catalog-invalid-'));
  const sourceDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-source-'));
  try {
    await writeSource(sourceDir, [{ ...VALID_ENTRY, review: { status: 'unreviewed', reviewedAt: null } }]);
    await assert.rejects(() => generateMarketplaceCatalog({ publicDir, websiteRoot: sourceDir }));
  } finally {
    await rm(publicDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  }
});

test('rejects inexact versions, malformed SRI, and private registry bindings', async () => {
  for (const distribution of [
    { ...VALID_ENTRY.distribution, version: '^1.0.0' },
    { ...VALID_ENTRY.distribution, integrity: 'sha512-not-complete' },
    { ...VALID_ENTRY.distribution, registryProfileId: 'private-registry' },
  ]) {
    const publicDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-catalog-invalid-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-marketplace-source-'));
    try {
      await writeSource(sourceDir, [{ ...VALID_ENTRY, distribution }]);
      await assert.rejects(() => generateMarketplaceCatalog({ publicDir, websiteRoot: sourceDir }));
    } finally {
      await rm(publicDir, { recursive: true, force: true });
      await rm(sourceDir, { recursive: true, force: true });
    }
  }
});

test('publication configuration exposes only the curated catalog path on the marketplace host', async () => {
  const wrangler = await readFile(join(websiteRoot, 'wrangler.toml'), 'utf8');
  assert.match(wrangler, /pattern\s*=\s*"marketplace\.happier\.dev\/catalog\.json"[\s\S]*?zone_name\s*=\s*"happier\.dev"/u);
  assert.doesNotMatch(wrangler, /pattern\s*=\s*"marketplace\.happier\.dev"\s*[\r\n]+\s*custom_domain\s*=\s*true/u);
});

test('committed editorial source parses offline without npm availability', async () => {
  const raw = await readFile(join(websiteRoot, 'marketplace', 'catalog.source.json'), 'utf8');
  const source = JSON.parse(raw);
  assert.ok(Array.isArray(source.entries));
});
