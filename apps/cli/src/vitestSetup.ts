import '../../ui/sources/dev/vitestDomTextEncoding';
import './configureZodLocale';
import './vitestHomeGuard';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';
import { createTestTempDirectory } from '../../../scripts/testing/process/temporaryDirectories.mjs';

// The first setup file establishes the disposable Home before this import graph.

// CLI unit tests should be machine-agnostic: provider CLIs are not expected to be installed
// on CI runners. Provide a default OpenCode CLI stub unless a test explicitly overrides it.
const opencodePath = String(process.env.HAPPIER_OPENCODE_PATH ?? '').trim();
if (!opencodePath) {
  const bin = createTestTempDirectory('happier-dev-test-bin-');
  const binDir = bin.root;
  const stubPath = join(binDir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  if (process.platform === 'win32') {
    writeFileSync(stubPath, '@echo off\r\nexit /B 0\r\n', 'utf8');
  } else {
    writeFileSync(stubPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(stubPath, 0o755);
  }
  process.env.HAPPIER_OPENCODE_PATH = stubPath;
  afterAll(() => {
    if (process.env.HAPPIER_OPENCODE_PATH === stubPath) delete process.env.HAPPIER_OPENCODE_PATH;
    bin.cleanup();
  });
}

// CLI tests should not inherit embedded build-policy gating (set in CI).
// Clear it by default so feature tests can opt-in explicitly per case.
process.env.HAPPIER_FEATURE_POLICY_ENV = '';

// The Home guard must inspect real configuration before test mocks exist.
// Release its product import graph so each file's hoisted OS boundary mocks
// apply when that file imports configuration and its dependent adapters.
vi.resetModules();
