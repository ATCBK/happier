import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

// This test intentionally pays the full startup cost of a fresh `node --import tsx` process.
// Keep ample headroom so full-suite lane contention does not look like an import-cycle regression.
const MODULE_IMPORT_TIMEOUT_MS = 60_000;

function importInFreshProcess(relativeEntryPath: string): ReturnType<typeof spawnSync> {
  const entryUrl = pathToFileURL(path.join(__dirname, relativeEntryPath)).href;
  const script = `import(${JSON.stringify(entryUrl)})`;

  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: MODULE_IMPORT_TIMEOUT_MS,
  });
}

function expectSuccessfulImport(result: ReturnType<typeof spawnSync>): void {
  const diagnostics = [
    `status=${String(result.status)}`,
    `signal=${String(result.signal)}`,
    `error=${result.error ? result.error.message : 'none'}`,
    `stderr=${result.stderr?.trim() || '<empty>'}`,
  ].join('\n');

  expect(result.error, diagnostics).toBeUndefined();
  expect(result.signal, diagnostics).toBeNull();
  expect(result.status, diagnostics).toBe(0);
}

describe('protocol ESM import safety', () => {
  it.each([
    'actions/actionIds.ts',
    'actions/npmRegistryProfileActionFamily.ts',
    'plugins/contributions/ui/v2.ts',
  ])(
    'imports %s in a fresh process without Action catalog initialization errors',
    (entryPath) => {
      expectSuccessfulImport(importInFreshProcess(entryPath));
    },
    MODULE_IMPORT_TIMEOUT_MS + 5_000,
  );

  it(
    'imports executionRuns under node + tsx without initialization errors',
    () => {
      expectSuccessfulImport(importInFreshProcess('execution/runs/index.ts'));
    },
    MODULE_IMPORT_TIMEOUT_MS + 5_000
  );

  it.each([
    'connect/connectedAccountPurposes.ts',
    'connect/connectedServiceSchemas.ts',
  ])(
    'imports %s in a fresh process without connected-service initialization errors',
    (entryPath) => {
      expectSuccessfulImport(importInFreshProcess(entryPath));
    },
    MODULE_IMPORT_TIMEOUT_MS + 5_000,
  );
});
