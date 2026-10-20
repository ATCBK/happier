import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin(['plugin-sdk', 'protocol', 'triage-protocol', 'triage-sources', 'agents'].map((name) => ({
    packageName: `@happier-dev/${name}`, packageSourceRoot: resolve(repoRoot, `packages/${name}/src`),
  })))],
  test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'] },
});
