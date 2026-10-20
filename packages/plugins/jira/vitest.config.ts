import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, '../../..');
export default defineConfig({
    root,
    plugins: [createWorkspacePackageSourcesPlugin([
        ...['plugin-sdk', 'protocol', 'triage-protocol', 'triage-sources', 'plugin-ui'].map((name) => ({
            packageName: `@happier-dev/${name}`,
            packageSourceRoot: resolve(repo, `packages/${name}/src`),
        })),
    ])],
    test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'] },
});
