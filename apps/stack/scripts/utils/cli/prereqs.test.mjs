import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertCliPrereqs } from './prereqs.mjs';

test('assertCliPrereqs({pnpm:true}) accepts pnpm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hs-prereqs-pnpm-'));
  const oldPath = process.env.PATH;
  try {
    const pnpmBin = join(root, 'pnpm');
    await writeFile(pnpmBin, '#!/bin/sh\nexit 0\n', 'utf-8');
    await chmod(pnpmBin, 0o755);
    process.env.PATH = `/bin:${root}`;

    await assertCliPrereqs({ pnpm: true });
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('assertCliPrereqs({pnpm:true}) throws when pnpm is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hs-prereqs-no-pnpm-'));
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = root;
    await assert.rejects(() => assertCliPrereqs({ pnpm: true }), /pnpm/i);
  } finally {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});
