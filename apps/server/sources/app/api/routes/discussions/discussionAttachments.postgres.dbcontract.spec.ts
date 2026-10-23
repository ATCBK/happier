import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, vi } from 'vitest';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { initFilesLocalFromEnv, loadFiles } from '@/storage/blob/files';
import { initEncrypt } from '@/modules/encrypt';
import { discussionAttachmentContracts } from './discussionAttachments.testkit';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Discussion committed private attachments (PostgreSQL)', () => {
    let baseDir: string;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)
            throw new Error('Discussion attachment contracts require the existing disposable PostgreSQL harness');
        baseDir = await mkdtemp(join(tmpdir(), 'happier-discussion-files-pg-'));
        vi.stubEnv('HAPPIER_SERVER_LIGHT_DATA_DIR', baseDir);
        vi.stubEnv('HANDY_MASTER_SECRET', 'discussion-attachment-disposable-test-secret');
        await initEncrypt();
        initFilesLocalFromEnv(process.env);
        await loadFiles();
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => {
        await shutdownDbClient();
        if (baseDir) await rm(baseDir, { recursive: true, force: true });
        vi.unstubAllEnvs();
    });
    discussionAttachmentContracts();
});
