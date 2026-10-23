import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const uiRoot = path.join(repoRoot, 'apps', 'ui');

const RELATIVE_IMPORT = /(?:from|import\(|require\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;

/** Relative import targets inside apps/ui, keyed by apps/ui-relative path, from shipped sources. */
function collectRelativeImportTargets() {
  const targets = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(file);
        continue;
      }
      if (!SOURCE_FILE.test(entry.name) || TEST_FILE.test(entry.name)) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(RELATIVE_IMPORT)) {
        const target = path.relative(uiRoot, path.resolve(path.dirname(file), match[1]));
        if (target.startsWith('..') || targets.has(target)) continue;
        targets.set(target, path.relative(uiRoot, file));
      }
    }
  };
  walk(path.join(uiRoot, 'sources'));
  return targets;
}

/** Evaluates apps/ui/.easignore with git's own ignore semantics, isolated from repository rules. */
function listEasIgnored(paths) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-easignore-'));
  try {
    execFileSync('git', ['init', '-q', sandbox]);
    fs.copyFileSync(path.join(uiRoot, '.easignore'), path.join(sandbox, '.gitignore'));
    try {
      return execFileSync('git', ['-C', sandbox, 'check-ignore', '--no-index', '--stdin'], {
        input: `${paths.join('\n')}\n`,
        encoding: 'utf8',
      }).split('\n').filter(Boolean);
    } catch (error) {
      // git check-ignore exits 1 when no path is ignored.
      if (error.status === 1) return [];
      throw error;
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

test('EAS uploads every apps/ui module that shipped sources import', () => {
  const targets = collectRelativeImportTargets();
  const outsideSources = [...targets.keys()].filter((target) => !target.startsWith(`sources${path.sep}`));
  assert.ok(outsideSources.includes(path.join('public', 'vendor', 'kokoro', 'resolveKokoroVoice.js')),
    'expected the shared Kokoro voice resolver import to be inspected');
  const excluded = listEasIgnored(outsideSources).map((target) => `${target} (imported by ${targets.get(target)})`);
  assert.deepEqual(excluded, [], 'native EAS bundles cannot resolve imports that .easignore removes');
});
