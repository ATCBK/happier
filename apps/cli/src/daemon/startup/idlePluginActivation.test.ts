import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { it } from 'vitest';

it.each(['resources', 'composerReferences', 'resourceWatch', 'promptAssets', 'concurrentResourceAction'] as const)('keeps an installed plugin cold until first %s demand in a fresh process', async (firstDemand) => {
    const privateHome = await mkdtemp(join(tmpdir(), 'happier-idle-plugin-activation-'));
    try {
        await promisify(execFile)(process.execPath, [
            '--import', fileURLToPath(new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url)),
            fileURLToPath(new URL('./fixtures/idlePluginActivation.mjs', import.meta.url)),
            firstDemand,
        ], {
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            env: { ...process.env, HAPPIER_HOME_DIR: privateHome,
                TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) },
            encoding: 'utf8',
        });
    } finally {
        await rm(privateHome, { recursive: true, force: true });
    }
}, 180_000);
