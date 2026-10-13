import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const realRepo = process.env.CI03_REAL_REPO ?? repo;
const reporter = join(repo, 'scripts/ci/reportGateRegressions.mjs');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.ifError(result.error);
  return result;
}
function triage(root, kind, input, status, extra = []) {
  return run(process.execPath, [reporter, `--root=${root}`, `--kind=${kind}`, `--input=${input}`,
    `--package-status=${status}`, ...extra], { env: { ...process.env, GITHUB_ACTIONS: 'true' } });
}

test('real native compiler output is attributed and compared without changing compiler failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ci03-compiler-seam-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'apps/fixture');
  await mkdir(dir, { recursive: true });
  const reports = join(root, 'reports');
  await mkdir(reports);
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [], noEmit: true }, files: ['case.ts'] }));
  await writeFile(join(dir, 'case.ts'), 'export const a: string = 1;\n');
  const compile = () => run(process.execPath, [join(realRepo, 'scripts/workspaces/runTypeScriptCli.mjs'), '--project', 'tsconfig.json', '--noEmit'], {
    cwd: dir, env: { ...process.env, HAPPIER_TYPECHECK_REPORT_DIR: reports },
  });
  const first = compile();
  assert.ok([1, 2].includes(first.status), first.stdout + first.stderr);
  assert.match(first.stdout, /error TS2322/);
  const baseline = join(root, 'baseline.json');
  const capture = triage(root, 'compiler', reports, first.status, [`--write-baseline=${baseline}`]);
  assert.equal(capture.status, first.status, capture.stderr);
  assert.match(capture.stdout, /New since baseline: 1/, capture.stderr);
  assert.match(capture.stdout, /apps\/fixture.*case.ts.*TS2322/s);
  const known = triage(root, 'compiler', reports, first.status, [`--baseline=${baseline}`]);
  assert.equal(known.status, first.status);
  assert.match(known.stdout, /New since baseline: 0/);
  // The process/admission adapter may write diagnostics to stderr around TS7.
  // Keep the real compiler result; model only that genuine process boundary.
  for (const name of await readdir(reports)) {
    const file = join(reports, name);
    const result = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...result, stderr: `${result.stderr}${first.stderr || '[compiler adapter] diagnostic\n'}` }));
  }
  const adapter = triage(root, 'compiler', reports, first.status, [`--baseline=${baseline}`]);
  assert.equal(adapter.status, first.status);
  assert.match(adapter.stdout, /New since baseline: 0/, adapter.stderr);
  const absentBaseline = triage(root, 'compiler', reports, first.status, [`--baseline=${join(root, 'not-yet-captured.json')}`]);
  assert.equal(absentBaseline.status, first.status);
  assert.match(absentBaseline.stdout, /Baseline unavailable/);
  assert.match(absentBaseline.stdout, /New since baseline: 1/);
  assert.match(known.stdout, /Package result: failed/);
  // An extra occurrence must remain new even when the message and file match.
  await writeFile(join(dir, 'case.ts'), '\nexport const a: string = 1;\nexport const b: string = 2;\n');
  const shared = join(root, 'packages/shared');
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, 'package.json'), JSON.stringify({ name: 'fixture-shared' }));
  await writeFile(join(shared, 'case.ts'), 'export const a: string = 1;\n');
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [], noEmit: true }, files: ['case.ts', '../../packages/shared/case.ts'] }));
  const nextReports = join(root, 'next-reports');
  await mkdir(nextReports);
  const next = run(process.execPath, [join(realRepo, 'scripts/workspaces/runTypeScriptCli.mjs'), '--project', 'tsconfig.json', '--noEmit'], {
    cwd: dir, env: { ...process.env, HAPPIER_TYPECHECK_REPORT_DIR: nextReports },
  });
  const changed = triage(root, 'compiler', nextReports, next.status, [`--baseline=${baseline}`]);
  assert.equal(changed.status, next.status);
  assert.match(changed.stdout, /New since baseline: 2/);
  assert.match(changed.stdout, /fixture-shared \(packages\/shared\): packages\/shared\/case.ts/,
    'a diagnostic imported by an app belongs to the source package, not the compiling consumer');
  assert.match(changed.stdout, /::notice file=apps\/fixture\/case.ts/);
  await writeFile(join(dir, 'case.ts'), 'export const c: string = 3;\n');
  const replacementReports = join(root, 'replacement-reports');
  await mkdir(replacementReports);
  const replacement = run(process.execPath, [join(realRepo, 'scripts/workspaces/runTypeScriptCli.mjs'), '--project', 'tsconfig.json', '--noEmit'], {
    cwd: dir, env: { ...process.env, HAPPIER_TYPECHECK_REPORT_DIR: replacementReports },
  });
  const replaced = triage(root, 'compiler', replacementReports, replacement.status, [`--baseline=${baseline}`]);
  assert.equal(replaced.status, replacement.status);
  assert.match(replaced.stdout, /New since baseline: 2/, 'fixing one error does not hide a new identical message elsewhere in that file');
  assert.match(replaced.stdout, /Resolved since baseline: 1/);
  const clean = triage(root, 'compiler', nextReports, 0, [`--baseline=${baseline}`]);
  assert.equal(clean.status, 0, 'reporting never overrides the supplied terminal package result');
});

test('real Vitest JSON passes through triage, including new and recovered cases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ci03-vitest-seam-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'apps/fixture');
  await mkdir(dir, { recursive: true });
  await symlink(join(realRepo, 'node_modules'), join(root, 'node_modules'), 'dir');
  const config = join(dir, 'vitest.config.mjs');
  await writeFile(config, 'export default { test: { include: ["**/*.test.mjs"], maxWorkers: 1, minWorkers: 1, isolate: true } };');
  const source = join(dir, 'case.test.mjs');
  const execute = (output, baseline) => run(process.execPath, [join(realRepo, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    '--reporter=json', `--reporter=${reporter}`, `--outputFile=${output}`], {
    cwd: dir, env: { ...process.env, HAPPIER_GATE_TRIAGE_ROOT: root, ...(baseline ? { HAPPIER_GATE_TRIAGE_BASELINE: baseline } : {}) },
  });
  await writeFile(source, 'import {test, expect} from "vitest"; test("known", () => expect(1).toBe(2));');
  const input = join(root, 'unit.json');
  assert.equal(execute(input).status, 1);
  const baseline = join(root, 'baseline.json');
  const captured = triage(root, 'unit', input, 1, [`--write-baseline=${baseline}`]);
  assert.equal(captured.status, 1);
  assert.match(captured.stdout, /New since baseline: 1/);
  const known = triage(root, 'unit', input, 1, [`--baseline=${baseline}`]);
  assert.equal(known.status, 1);
  assert.match(known.stdout, /New since baseline: 0/);
  await writeFile(source, 'import {test, expect} from "vitest"; test("known", () => expect(1).toBe(2)); test("new", () => expect(true).toBe(false));');
  const newCaseRun = execute(input, baseline);
  assert.equal(newCaseRun.status, 1);
  assert.match(newCaseRun.stdout, /New since baseline: 1/, 'the real Vitest reporter hook must consume the JSON baseline');
  const changed = triage(root, 'unit', input, 1, [`--baseline=${baseline}`]);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /New since baseline: 1/);
  assert.match(changed.stdout, /apps\/fixture.*new/s);
  await writeFile(source, 'import {test, expect} from "vitest"; test("known", () => expect(1).toBe(1));');
  assert.equal(execute(input).status, 0);
  const recovered = triage(root, 'unit', input, 0, [`--baseline=${baseline}`]);
  assert.equal(recovered.status, 0);
  assert.match(recovered.stdout, /Resolved since baseline: 1/);
  const missing = triage(root, 'unit', join(root, 'missing.json'), 137, [`--baseline=${baseline}`]);
  assert.equal(missing.status, 137, 'missing telemetry never clears a crash');
  assert.match(missing.stdout + missing.stderr, /Triage unavailable/);
  assert.equal((await readFile(baseline, 'utf8')).includes('known'), true);
});
