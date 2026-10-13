import assert from 'node:assert/strict';
import test from 'node:test';

import { compareCompilerBaseline, diagnosticsFromCompilerReport, mapUnchangedLine, parseCompilerBaseline } from './compilerBaseline.mjs';

const diagnostic = { package: 'apps/ui', file: 'apps/ui/sources/example.ts', line: 10, column: 3, code: 2322, message: "Type 'number' is not assignable to type 'string'." };
const baseline = { sourceCommit: 'a'.repeat(40), diagnostics: [diagnostic] };
const report = (overrides = {}) => ({ cwd: '/repo/apps/ui', project: 'tsconfig.source.json', status: 1, signal: null, stdout: "sources/example.ts(10,3): error TS2322: Type 'number' is not assignable to type 'string'.\n", stderr: '', ...overrides });

test('native diagnostics retain full multiline meaning and normalize source roots and separators', () => {
  const rows = diagnosticsFromCompilerReport(report({ stdout: "sources\\example.ts(10,3): error TS2322: Type 'number' is not assignable to type 'string'.\n  Property 'x' is missing.\n" }), '/repo');
  assert.deepEqual(rows, [{ ...diagnostic, message: `${diagnostic.message} Property 'x' is missing.` }]);
});

test('covered diagnostics never hide compiler crashes, malformed output, config failure or missing diagnostics', () => {
  for (const overrides of [
    { status: null, signal: 'SIGKILL' }, { status: 137 }, { status: 1, stdout: '' },
    { status: 0 }, { stderr: 'fatal error: out of memory' },
    { stdout: 'error TS5058: The specified path does not exist.\n' },
    { stdout: `${report().stdout}unexpected compiler output\n` },
  ]) assert.throws(() => diagnosticsFromCompilerReport(report(overrides), '/repo'));
  assert.deepEqual(diagnosticsFromCompilerReport(report({ status: 0, stdout: '' }), '/repo'), []);
});

test('line mapping tolerates insertions and deletions before unchanged diagnostics only', () => {
  const patch = '@@ -2,0 +3,4 @@\n+a\n+b\n+c\n+d\n@@ -8,2 +12,0 @@\n-e\n-f\n';
  assert.equal(mapUnchangedLine(10, patch), 12);
  assert.equal(mapUnchangedLine(8, patch), null);
  assert.equal(mapUnchangedLine(2, patch), 2);
});

test('baseline comparison distinguishes shifted errors, new locations and extra identical occurrences', () => {
  const shifted = { ...diagnostic, line: 12 };
  const mapLine = () => 12;
  assert.deepEqual(compareCompilerBaseline(baseline, baseline, [shifted], mapLine), baseline);
  assert.throws(() => compareCompilerBaseline(baseline, baseline, [shifted, shifted], mapLine), /new compiler diagnostics/);
  assert.throws(() => compareCompilerBaseline(baseline, baseline, [{ ...shifted, line: 13 }], mapLine), /new compiler diagnostics/);
  assert.throws(() => compareCompilerBaseline(baseline, baseline, [shifted], () => null), /new compiler diagnostics/);
});

test('refresh removes disappeared diagnostics permanently and never admits baseline increases or relocation', () => {
  const reduced = compareCompilerBaseline(baseline, baseline, [], line => line);
  assert.deepEqual(reduced.diagnostics, []);
  assert.throws(() => compareCompilerBaseline(reduced, reduced, [diagnostic], line => line), /new compiler diagnostics/);
  for (const changed of [
    { ...baseline, diagnostics: [diagnostic, diagnostic] },
    { ...baseline, diagnostics: [{ ...diagnostic, line: 11 }] },
    { ...baseline, sourceCommit: 'b'.repeat(40) },
  ]) assert.throws(() => compareCompilerBaseline(changed, baseline, [], line => line), /baseline.*(increase|source commit)/);
});

test('baseline schema rejects corrupt, permissive and invalid locations before suppression', () => {
  assert.deepEqual(parseCompilerBaseline(JSON.stringify(baseline)), baseline);
  for (const value of [null, {}, { ...baseline, extra: true }, { ...baseline, diagnostics: [{ ...diagnostic, line: 0 }] }, { ...baseline, diagnostics: [{ ...diagnostic, file: '../other.ts' }] }]) {
    assert.throws(() => parseCompilerBaseline(JSON.stringify(value)), /invalid compiler baseline/);
  }
});
