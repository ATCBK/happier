import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution.ts';
import { createTestHomeEnvironment } from '../../scripts/testing/testHomeEnvironment.mjs';

const workspacePackages = ['agents', 'cli-common', 'protocol', 'release-runtime'].map((name) => ({
  packageName: `@happier-dev/${name}`,
  packageSourceRoot: fileURLToPath(new URL(`../${name}/src`, import.meta.url)),
}));

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages, 'happier-cli-common-workspace-package-sources')],
  test: {
    env: createTestHomeEnvironment().env,
    setupFiles: [fileURLToPath(new URL('../../scripts/testing/vitestHomeSetup.mjs', import.meta.url))],
    sequence: { setupFiles: 'list' },
    environment: 'node',
    maxWorkers: 1,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: ['tests/**/*.mjs', 'dist/**', 'node_modules/**'],
  },
});
