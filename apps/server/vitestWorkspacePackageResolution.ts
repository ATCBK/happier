import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createWorkspacePackageSourcesPlugin,
    readHostWorkspacePackageSpecs,
} from '../../scripts/testing/vitestWorkspacePackageResolution.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export const serverWorkspacePackageSourcesPlugin = createWorkspacePackageSourcesPlugin(readHostWorkspacePackageSpecs(repoRoot, here, [
    {
        packageName: '@happier-dev/channels-protocol',
        packageSourceRoot: resolve(repoRoot, 'packages', 'channels-protocol', 'src'),
    },
    {
        packageName: '@happier-dev/sdk',
        packageSourceRoot: resolve(repoRoot, 'packages', 'sdk', 'src'),
    },
    {
        packageName: '@happier-dev/plugin-sdk',
        packageSourceRoot: resolve(repoRoot, 'packages', 'plugin-sdk', 'src'),
    },
    {
        packageName: '@happier-dev/sync-client',
        packageSourceRoot: resolve(repoRoot, 'packages', 'sync-client', 'src'),
    },
    {
        packageName: 'privacy-kit',
        packageSourceRoot: resolve(repoRoot, 'packages', 'privacy-kit', 'src'),
    },
]), 'happier-server-workspace-package-sources');
