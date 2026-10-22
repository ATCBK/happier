import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findRepoRoot } from './optionalWorkspaceBundleLock.mjs';
import { findRepoRoot as findSdkRepoRoot } from '../../../packages/plugin-sdk/scripts/vendoredWorkspaceDeclarations.mjs';

test('root discovery selects the pnpm workspace rather than a nested Yarn project', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-pnpm-root-'));
  try {
    const nested = join(root, 'apps', 'cli', 'scripts');
    mkdirSync(nested, { recursive: true });
    for (const name of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
      writeFileSync(join(root, name), '');
    }
    writeFileSync(join(root, 'apps', 'package.json'), '{}');
    writeFileSync(join(root, 'apps', 'yarn.lock'), '');
    writeFileSync(join(root, 'apps', 'pnpm-lock.yaml'), '');
    assert.equal(findRepoRoot(nested), root);
    assert.equal(findSdkRepoRoot(nested), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
