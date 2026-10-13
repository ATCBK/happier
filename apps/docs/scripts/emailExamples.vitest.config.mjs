import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export default defineConfig({
  root: repoRoot,
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(repoRoot, 'packages/protocol/src') },
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src') },
    { packageName: '@happier-dev/channels-protocol', packageSourceRoot: resolve(repoRoot, 'packages/channels-protocol/src') },
  ])],
  test: {
    include: ['apps/docs/scripts/emailExamples.spec.mjs'],
    environment: 'node', pool: 'forks', maxWorkers: 1, minWorkers: 1,
  },
});
