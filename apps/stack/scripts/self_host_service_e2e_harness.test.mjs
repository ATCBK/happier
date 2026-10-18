import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from './self_host_service_e2e_harness.mjs';

test('self-host commands fail before execution when the containing test deadline expired', () => {
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(0)'], {
    deadlineAtMs: Date.now() - 1,
  }), /test deadline exceeded/);
});

test('self-host preparation can use the containing deadline without a shorter phase cutoff', () => {
  const result = run(process.execPath, ['-e', 'process.stdout.write("built")'], {
    deadlineAtMs: Date.now() + 60_000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'built');
});
