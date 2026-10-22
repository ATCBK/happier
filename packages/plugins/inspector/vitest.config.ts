import { createRequire } from 'node:module';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../../scripts/testing/featureTestGating';
import {
  createWorkspacePackageSourcesPlugin,
  type WorkspacePackageSpec,
} from '../../../scripts/testing/vitestWorkspacePackageResolution';

const requireUiDependency = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../../..');

const workspacePackages: readonly WorkspacePackageSpec[] = [
  { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(repoRoot, 'packages/protocol/src') },
  { packageName: '@happier-dev/agents', packageSourceRoot: resolve(repoRoot, 'packages/agents/src') },
  { packageName: '@happier-dev/cli-common', packageSourceRoot: resolve(repoRoot, 'packages/cli-common/src') },
  { packageName: '@happier-dev/triage-protocol', packageSourceRoot: resolve(repoRoot, 'packages/triage-protocol/src') },
  {
    packageName: '@happier-dev/plugin-sdk',
    packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src'),
  },
  {
    packageName: '@happier-dev/plugin-ui',
    packageSourceRoot: resolve(repoRoot, 'packages/plugin-ui/src'),
  },
];

/**
 * The semantic fixture is supporting RNW evidence, so it must load the same
 * React/RNW module instances as the UI package's own RNW test project. The
 * production Vite config instead externalizes these modules through the host
 * runtime and is intentionally not a test runtime.
 */
const reactNativeWebAliases = [
  { find: /^react$/u, replacement: requireUiDependency.resolve('react') },
  { find: /^react\/jsx-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-runtime') },
  { find: /^react\/jsx-dev-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-dev-runtime') },
  { find: /^react-dom\/client$/u, replacement: requireUiDependency.resolve('react-dom/client') },
  { find: /^react-dom$/u, replacement: requireUiDependency.resolve('react-dom') },
  { find: /^react-native$/u, replacement: requireUiDependency.resolve('react-native-web/dist/index.js') },
  // Match the canonical plugin-ui RNW platform boundary; Vite does not select .web files.
  { find: /^react-native-svg$/u, replacement: requireUiDependency.resolve('react-native-svg/lib/module/elements.web.js') },
];

export default defineConfig({
  resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
  plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
  test: {
    ...resolveVitestWorkers(),
    globals: false,
    environment: 'node',
    include: ['src/**/*.{spec,test}.ts', 'src/**/*.{spec,test}.tsx'],
    exclude: [
      '**/.project/**',
      '**/.worktrees/**',
      '**/.dev/**',
      '**/output/**',
      '**/node_modules/**',
      '**/dist/**',
      ...resolveVitestFeatureTestExcludeGlobs(),
    ],
  },
});
