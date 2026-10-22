import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { readWorkspacePatterns } from '../../apps/stack/scripts/utils/proc/workspace_package_manifests.mjs';

function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function segmentPatternToRegex(pattern) {
  const source = Array.from(pattern)
    .map((char) => {
      if (char === '*') return '.*';
      return escapeRegex(char);
    })
    .join('')
    .replace(/\\\[a-z\\\]/g, '[a-z]');

  return new RegExp(`^${source}$`);
}

function workspacePathExists(repoRoot, rel) {
  const literalPath = resolve(repoRoot, rel);
  if (existsSync(literalPath)) return true;
  if (!/[*[]/.test(rel)) return false;

  const parentPath = resolve(repoRoot, dirname(rel));
  if (!existsSync(parentPath)) return false;

  const pattern = segmentPatternToRegex(basename(rel));
  return readdirSync(parentPath, { withFileTypes: true }).some((entry) => {
    if (!entry.isDirectory()) return false;
    return pattern.test(entry.name) && existsSync(resolve(parentPath, entry.name, 'package.json'));
  });
}

test('repo workspaces paths exist on disk', async () => {
  const repoRoot = resolve(import.meta.dirname, '..', '..');
  const workspacePkgs = await readWorkspacePatterns(repoRoot);
  assert.ok(workspacePkgs.length > 0, 'pnpm-workspace.yaml must declare workspace packages');

  const missing = [];
  for (const rel of workspacePkgs) {
    if (typeof rel !== 'string') continue;
    if (!workspacePathExists(repoRoot, rel)) missing.push(rel);
  }

  assert.deepEqual(
    missing,
    [],
    `pnpm-workspace.yaml packages contains paths that do not exist:\n${missing.map((p) => `- ${p}`).join('\n')}`
  );
});
