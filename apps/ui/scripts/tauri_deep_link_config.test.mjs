import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import releaseRings from '../../../packages/release-runtime/releaseRings.cjs';
const { getReleaseRingCatalogEntry } = releaseRings;

const channels = [['stable', 'tauri.conf.json'], ['preview', 'tauri.preview.conf.json'], ['publicdev', 'tauri.publicdev.conf.json']];

for (const [ring, filename] of channels) {
  test(`desktop ${ring} registers its channel's pairing scheme`, async () => {
    const config = JSON.parse(await readFile(new URL(`../src-tauri/${filename}`, import.meta.url), 'utf8'));
    assert.deepEqual(config.plugins?.['deep-link']?.desktop?.schemes, [getReleaseRingCatalogEntry(ring).appScheme]);
  });
}

test('desktop channel binary identities are distinct from each other and the CLI', async () => {
  const configs = await Promise.all(channels.map(async ([, filename]) =>
    JSON.parse(await readFile(new URL(`../src-tauri/${filename}`, import.meta.url), 'utf8'))));
  const binaryNames = configs.map((config) => config.mainBinaryName);
  for (const name of binaryNames) {
    assert.equal(typeof name, 'string');
    assert.match(name, /^[a-z][a-z0-9-]+$/);
    assert.notEqual(name, 'app');
    assert.notEqual(name, 'happier');
  }
  assert.equal(new Set(binaryNames).size, 3);
  const [stable] = configs;
  assert.equal(stable.bundle.category, 'DeveloperTool');
  assert.ok(stable.bundle.publisher);
  assert.ok(stable.bundle.shortDescription);
  assert.ok(stable.bundle.longDescription);
});
