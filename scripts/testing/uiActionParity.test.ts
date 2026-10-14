import assert from 'node:assert/strict';
import test from 'node:test';
import { readCurrentUiActionParity } from './validateUiActionParity.ts';

// Filesystem/source analysis belongs to the Node tooling harness, not a loaded UI worker.
test('maps current UI Action invocations, registrations and settings mutations to agent-visible canonical specs', () => {
  const report = readCurrentUiActionParity();
  assert.ok(report.actions.length > 0);
  assert.ok(report.settings.length > 0);
  assert.deepEqual(report.findings.map(finding => `${finding.filePath}:${finding.line} ${finding.code}: ${finding.operation}`), []);
});
