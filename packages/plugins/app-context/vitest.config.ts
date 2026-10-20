import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const sourceRoot = (name: string) => fileURLToPath(new URL(`../../${name}/src`, import.meta.url));

export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: sourceRoot('plugin-sdk') },
    { packageName: '@happier-dev/protocol', packageSourceRoot: sourceRoot('protocol') },
    { packageName: '@happier-dev/agents', packageSourceRoot: sourceRoot('agents') },
  ])],
  test: { environment: 'node', include: ['src/**/*.test.ts'], fileParallelism: false },
});
