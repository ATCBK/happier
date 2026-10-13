import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Linux compiler reports measure the admitted process tree and preserve child failures', { skip: process.platform !== 'linux' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'happier-compiler-memory-'));
  try {
    const reportPath = join(root, 'report.json');
    const measured = spawnSync('python3', [fileURLToPath(new URL('./measureTypeScriptCompiler.py', import.meta.url)), reportPath,
      'python3', '-c', 'import time; payload = bytearray(8 * 1024 * 1024); time.sleep(0.3); raise SystemExit(2)'], {
      env: { ...process.env, HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN: `${process.pid}:fixture` }, encoding: 'utf8',
    });
    assert.equal(measured.status, 0, measured.stderr);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.status, 2);
    assert.equal(report.signal, null);
    assert.equal(report.aggregateRootPid, process.pid);
    assert.equal(report.aggregateRootScope, 'admitted-command');
    assert.ok(report.maxRssKiB > 0);
    assert.ok(report.aggregateMaxRssKiB >= report.maxRssKiB, 'aggregate includes the compiler and its live ancestors');
    assert.ok(report.ancestorMaxRssKiB > 0);
    assert.ok(report.elapsedMs >= 300);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
