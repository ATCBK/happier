import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const realRepo = process.env.CI03_REAL_REPO ?? repo;
const runner = join(repo, 'apps/ui/scripts/runVitestShards.mjs');

test('eight real unit invocations cover each file once and respect the canonical worker budget', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ci03-eight-ui-seam-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(join(realRepo, 'node_modules'), join(root, 'node_modules'), 'dir');
  const config = join(root, 'vitest.config.mjs');
  await writeFile(config, 'export default { test: { include: ["**/*.test.mjs"], maxWorkers: 2, minWorkers: 1 } };');
  for (let index = 0; index < 16; index++) {
    await writeFile(join(root, `case-${index}.test.mjs`), `import {test, expect} from "vitest"; test("case ${index}", () => expect(true).toBe(true));`);
  }
  const run = (part, extraEnv = {}) => {
    const output = join(root, `part-${part}.json`);
    const result = spawnSync(process.execPath, [runner, '--config', config, '--reporter=json', `--outputFile=${output}`], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HAPPIER_UI_VITEST_PART: String(part), HAPPIER_UI_VITEST_PARTS: '8',
        HAPPIER_VITEST_MAX_WORKERS: '2', VITEST_MAX_FORKS: '2', VITEST_MIN_FORKS: '1', ...extraEnv },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return output;
  };
  const files = [];
  for (let part = 1; part <= 8; part++) {
    const report = JSON.parse(await readFile(run(part), 'utf8'));
    files.push(...report.testResults.map(row => row.name));
  }
  assert.equal(files.length, 16, 'the matrix must not replay the whole suite in every partition');
  assert.equal(new Set(files).size, 16, 'no file may be duplicated or omitted');
  for (let index = 0; index < 16; index++) {
    await writeFile(join(root, `case-${index}.test.mjs`), 'import {test, expect} from "vitest"; test("worker binding", () => expect(process.env.VITEST_MAX_FORKS).toBe("2"));');
  }
  run(1, { VITEST_MAX_FORKS: '9' });
});
