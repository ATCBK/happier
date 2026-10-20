import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import rootConfig from '../../vitest.config';
import { createWorkspaceHostSourceAlias, createWorkspacePackageSourcesPlugin } from './vitestWorkspacePackageResolution';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
    ...rootConfig,
    test: {
        ...rootConfig.test,
        setupFiles: [
            fileURLToPath(new URL('./vitestHomeSetup.mjs', import.meta.url)),
            ...(Array.isArray(rootConfig.test?.setupFiles) ? rootConfig.test.setupFiles
                : rootConfig.test?.setupFiles ? [rootConfig.test.setupFiles] : []),
        ],
    },
    plugins: [createWorkspacePackageSourcesPlugin(['protocol', 'cli-common', 'plugin-sdk', 'sync-client', 'session-core'].map(name => ({
        packageName: `@happier-dev/${name}`,
        packageSourceRoot: `${repoRoot}/packages/${name}/src`,
    })), 'happier-question-owner-source-packages')],
    resolve: {
        conditions: ['happier-source', 'node', 'import', 'default'],
        alias: [createWorkspaceHostSourceAlias(repoRoot, `${repoRoot}/apps/cli/src`)],
    },
});
