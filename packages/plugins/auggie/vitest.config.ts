import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

// Resolve the same moving workspace source beneath the plugin testkit, rather
// than mixing a new manifest with dependency-local prepared Protocol copies.
const sourceRoot = (name: string) => fileURLToPath(new URL(`../../${name}/src`, import.meta.url));
export default defineConfig({
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/protocol', packageSourceRoot: sourceRoot('protocol') },
    { packageName: '@happier-dev/agents', packageSourceRoot: sourceRoot('agents') },
    { packageName: '@happier-dev/cli-common', packageSourceRoot: sourceRoot('cli-common') },
    { packageName: '@happier-dev/channels-protocol', packageSourceRoot: sourceRoot('channels-protocol') },
    { packageName: '@happier-dev/triage-protocol', packageSourceRoot: sourceRoot('triage-protocol') },
    { packageName: '@happier-dev/triage-sources', packageSourceRoot: sourceRoot('triage-sources') },
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: sourceRoot('plugin-sdk') },
  ])],
  test: { setupFiles: ['../../protocol/src/test/zodLocaleSetup.ts'] },
});
