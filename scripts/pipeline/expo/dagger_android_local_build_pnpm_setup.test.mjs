import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function readRepoFile(relPath) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('dagger expoAndroidLocalBuild provisions pinned pnpm without Corepack and uses a frozen install', () => {
  const src = readRepoFile('dagger/src/index.ts');

  assert.match(
    src,
    /scripts\/ci\/setup-pnpm\.mjs/,
    'expected the shared integrity-checked pnpm setup before installation',
  );
  assert.match(src, /"pnpm",\s*"install",\s*"--frozen-lockfile"/);
  assert.match(src, /withMountedCache\("\/root\/\.local\/share\/pnpm\/store"/);
  assert.doesNotMatch(src, /corepack|yarn-install-with-retry/);
});
