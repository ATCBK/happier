import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareTypeScriptProjectBuild } from './prepareTypeScriptProjectBuild.mjs';
import * as preparation from './prepareTypeScriptProjectBuild.mjs';

test('removes stale incremental metadata when the configured outDir is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-ts-build-prep-'));
  try {
    const tsconfigPath = join(root, 'tsconfig.json');
    const buildInfoPath = join(root, '.tsbuildinfo');
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          outDir: 'dist',
          incremental: true,
          tsBuildInfoFile: '.tsbuildinfo',
        },
      }),
      'utf8',
    );
    writeFileSync(buildInfoPath, 'stale', 'utf8');

    prepareTypeScriptProjectBuild({ tsconfigPath });

    assert.equal(existsSync(buildInfoPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps incremental metadata when the configured outDir still exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-ts-build-prep-'));
  try {
    mkdirSync(join(root, 'dist'), { recursive: true });
    const tsconfigPath = join(root, 'tsconfig.json');
    const buildInfoPath = join(root, '.tsbuildinfo');
    writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          outDir: 'dist',
          incremental: true,
          tsBuildInfoFile: '.tsbuildinfo',
        },
      }),
      'utf8',
    );
    writeFileSync(buildInfoPath, 'fresh', 'utf8');

    prepareTypeScriptProjectBuild({ tsconfigPath });

    assert.equal(existsSync(buildInfoPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('partition coverage detects newly added roots and overlapping implementation ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-ts-partition-coverage-'));
  try {
    mkdirSync(join(root, 'src'));
    for (const name of ['first.ts', 'second.ts', 'shared.d.ts']) writeFileSync(join(root, 'src', name), name.endsWith('.d.ts') ? 'declare const shared: string;' : 'export const value = 1;');
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ include: ['src/**/*.ts'] }));
    const projectPaths = ['one', 'two'].map((name, index) => {
      const path = join(root, `tsconfig.${name}.json`);
      writeFileSync(path, JSON.stringify({ files: [`src/${index === 0 ? 'first' : 'second'}.ts`, 'src/shared.d.ts'] }));
      return path;
    });
    const verify = () => preparation.verifyTypeScriptProjectCoverage({ baselinePath: join(root, 'tsconfig.json'), projectPaths, cwd: root });
    const baseline = { configPath: join(root, 'tsconfig.json'),
      fileNames: ['first.ts', 'second.ts', 'shared.d.ts'].map(name => join(root, 'src', name)) };
    const verifySelected = (selectedBaseline = baseline) => preparation.verifyTypeScriptProjectCoverage({
      baselinePath: baseline.configPath, baseline: selectedBaseline, projectPaths, cwd: root,
    });
    await verify();
    writeFileSync(join(root, 'src', 'new.ts'), 'export const value = 2;');
    await verifySelected();
    await assert.rejects(verify(), /unassigned: src[/\\]new\.ts/);
    await assert.rejects(verifySelected({ ...baseline, configPath: join(root, 'other.json') }), /unassigned: src[/\\]new\.ts/);
    writeFileSync(projectPaths[1], JSON.stringify({ files: ['src/first.ts', 'src/second.ts', 'src/new.ts', 'src/shared.d.ts'] }));
    await assert.rejects(verify(), /duplicate: src[/\\]first\.ts/);
    await assert.rejects(verifySelected(), /duplicate: src[/\\]first\.ts/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
