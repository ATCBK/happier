import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { it } from 'vitest';

// This composes the complete daemon in a separate cold source-loader process.
it('leaves archive and HTML parser graphs unloaded until demand in a fresh daemon composition', async () => {
    const privateHome = await mkdtemp(join(tmpdir(), 'happier-idle-daemon-graph-'));
    try {
        await promisify(execFile)(process.execPath, [
            '--import', fileURLToPath(new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url)),
            fileURLToPath(new URL('./fixtures/idleDaemonGraph.mjs', import.meta.url)),
        ], {
            cwd: fileURLToPath(new URL('../../../', import.meta.url)),
            env: {
                ...process.env,
                HAPPIER_HOME_DIR: privateHome,
                TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
            },
            encoding: 'utf8',
        });
    } finally {
        await rm(privateHome, { recursive: true, force: true });
    }
}, 180_000);

