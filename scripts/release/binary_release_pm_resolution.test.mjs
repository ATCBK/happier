import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { resolveRepoRoot, resolvePnpmCommand } from '../pipeline/release/lib/binary-release.mjs';

test('resolvePnpmCommand requires the installed pnpm executable', () => {
  const result = resolvePnpmCommand({
    commandProbe: (cmd) => cmd === 'pnpm',
  });
  assert.deepEqual(result, { cmd: 'pnpm', args: [] });
});

test('resolvePnpmCommand rejects a worker with only Corepack', () => {
  assert.throws(() => resolvePnpmCommand({
    commandProbe: (cmd) => cmd === 'corepack',
  }), /requires pnpm/i);
});

test('resolvePnpmCommand throws when pnpm is unavailable', () => {
  assert.throws(
    () => resolvePnpmCommand({ commandProbe: () => false }),
    /requires pnpm/i
  );
});

test('resolveRepoRoot resolves the repo root from the module location', () => {
  assert.equal(resolve(resolveRepoRoot()), resolve(process.cwd()));
});
