import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, '../../..');
export default defineConfig({
    root,
    resolve: { alias: [
        { find: /^react$/u, replacement: resolve(repo, 'apps/ui/node_modules/react/index.js') },
        { find: /^react\/jsx-runtime$/u, replacement: resolve(repo, 'apps/ui/node_modules/react/jsx-runtime.js') },
        { find: /^react\/jsx-dev-runtime$/u, replacement: resolve(repo, 'apps/ui/node_modules/react/jsx-dev-runtime.js') },
        { find: /^react-dom\/client$/u, replacement: resolve(repo, 'apps/ui/node_modules/react-dom/client.js') },
        { find: /^react-dom$/u, replacement: resolve(repo, 'apps/ui/node_modules/react-dom/index.js') },
        { find: /^react-native$/u, replacement: resolve(repo, 'apps/ui/node_modules/react-native-web/dist/index.js') },
        { find: /^react-native-svg$/u, replacement: resolve(repo, 'apps/ui/node_modules/react-native-svg/lib/module/elements.web.js') },
    ], dedupe: ['react', 'react-dom'] },
    plugins: [createWorkspacePackageSourcesPlugin([
        ...['plugin-sdk', 'protocol', 'triage-protocol', 'triage-sources', 'plugin-ui'].map((name) => ({
            packageName: `@happier-dev/${name}`,
            packageSourceRoot: resolve(repo, `packages/${name}/src`),
        })),
    ])],
    test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
