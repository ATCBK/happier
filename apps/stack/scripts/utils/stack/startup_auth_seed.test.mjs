import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareDaemonAuthSeedIfNeeded } from './startup.mjs';
import { findAnyCredentialPathInCliHome, resolveStackCredentialPaths } from '../auth/credentials_paths.mjs';
import { runNodeCapture } from '../../testkit/core/run_node_capture.mjs';

async function createReadableSourceSqliteAccountDb({ stackRootDir, dataDir }) {
    const serverDir = join(dirname(stackRootDir), 'server');
    const databaseUrl = `file:${join(dataDir, 'happier-server-light.sqlite')}`;
    const result = await runNodeCapture([
        '--input-type=module',
        '-e',
        `
const { PrismaClient } = await import(${JSON.stringify(join(serverDir, 'generated', 'sqlite-client', 'index.js'))});
const db = new PrismaClient();
try {
  await db.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "Account" ("id" TEXT NOT NULL PRIMARY KEY, "publicKey" TEXT)');
} finally {
  await db.$disconnect();
}
        `.trim(),
    ], {
        cwd: serverDir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    assert.equal(result.code, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

test('prepareDaemonAuthSeedIfNeeded copies credentials from a non-running source stack via offline auth seeding', async (t) => {
    const utilsStackDir = dirname(fileURLToPath(import.meta.url));
    const stackScriptsDir = dirname(dirname(utilsStackDir));
    const stackRootDir = dirname(stackScriptsDir);
    const repoRoot = dirname(stackRootDir);

    const tmp = await mkdtemp(join(tmpdir(), 'hstack-startup-auth-seed-'));
    t.after(async () => {
        await rm(tmp, { recursive: true, force: true });
    });

    const homeDir = join(tmp, 'home');
    const storageDir = join(tmp, 'storage');
    const workspaceDir = join(tmp, 'workspace');
    const sourceStack = 'main';
    const targetStack = 'usage-analytics-qa';
    const sourceCliHome = join(storageDir, sourceStack, 'cli');
    const targetCliHome = join(storageDir, targetStack, 'cli');
    const sourceServerUrl = 'http://127.0.0.1:4201';
    const targetServerUrl = 'http://127.0.0.1:4202';

    await mkdir(homeDir, { recursive: true });
    await mkdir(storageDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sourceCliHome, { recursive: true });
    await mkdir(targetCliHome, { recursive: true });

    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });
    const pnpmPath = join(binDir, 'pnpm');
    await writeFile(pnpmPath, '#!/bin/bash\nexit 0\n', 'utf-8');
    await chmod(pnpmPath, 0o755);

    const writeStackEnv = async ({ stackName, cliHomeDir, serverPort }) => {
        const baseDir = join(storageDir, stackName);
        const dataDir = join(baseDir, 'server-light');
        await mkdir(dataDir, { recursive: true });
        await writeFile(
            join(baseDir, 'env'),
            [
                `HAPPIER_STACK_STACK=${stackName}`,
                'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
                `HAPPIER_STACK_REPO_DIR=${repoRoot}`,
                `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
                `HAPPIER_STACK_SERVER_PORT=${serverPort}`,
                `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
                `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(dataDir, 'files')}`,
                `HAPPIER_SERVER_LIGHT_DB_DIR=${join(dataDir, 'pglite')}`,
                '',
            ].join('\n'),
            'utf-8',
        );
    };

    await writeStackEnv({ stackName: sourceStack, cliHomeDir: sourceCliHome, serverPort: 4201 });
    await writeStackEnv({ stackName: targetStack, cliHomeDir: targetCliHome, serverPort: 4202 });
    await createReadableSourceSqliteAccountDb({
        stackRootDir,
        dataDir: join(storageDir, sourceStack, 'server-light'),
    });

    const sourceCredentialPaths = resolveStackCredentialPaths({
        cliHomeDir: sourceCliHome,
        serverUrl: sourceServerUrl,
    });
    await mkdir(dirname(sourceCredentialPaths.serverScopedPath), { recursive: true });
    await writeFile(sourceCredentialPaths.serverScopedPath, 'seed-token\n', 'utf-8');

    const env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HAPPIER_STACK_HOME_DIR: homeDir,
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
        HAPPIER_STACK_STACK: targetStack,
        HAPPIER_STACK_ENV_FILE: join(storageDir, targetStack, 'env'),
    };

    const result = await prepareDaemonAuthSeedIfNeeded({
        rootDir: stackRootDir,
        env,
        stackName: targetStack,
        cliHomeDir: targetCliHome,
        startDaemon: true,
        isInteractive: false,
        accountCount: 1,
        quiet: true,
    });

    assert.equal(result.ok, true, JSON.stringify(result, null, 2));

    const copiedPath = findAnyCredentialPathInCliHome({ cliHomeDir: targetCliHome });
    assert.ok(copiedPath, 'expected an auth seed credential to be materialized in the target cli home');
    const copied = await readFile(copiedPath, 'utf-8');
    assert.equal(copied.trim(), 'seed-token');
});
