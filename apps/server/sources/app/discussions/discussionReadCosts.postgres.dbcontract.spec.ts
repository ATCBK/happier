import { afterAll, beforeAll, describe, expect, vi } from 'vitest';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { initEncrypt } from '@/modules/encrypt';
import { discussionReadCostContracts } from './discussionReadCosts.testkit';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Discussion read demand (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HANDY_MASTER_SECRET', 'discussion-read-cost-disposable-fixture');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        initDbPostgres();
        await db.$connect();
        // This URL is admitted only by the disposable Docker harness above.
        // Set the database default and reconnect so every pooled session uses it.
        const [{ name }] = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
        await db.$executeRawUnsafe(`ALTER DATABASE "${name.replaceAll('"', '""')}" SET timezone TO 'Europe/Amsterdam'`);
        await shutdownDbClient();
        initDbPostgres();
        await db.$connect();
        expect(await db.$queryRaw`SELECT current_setting('TimeZone') AS timezone`).toEqual([{ timezone: 'Europe/Amsterdam' }]);
        await initEncrypt();
    });
    afterAll(async () => { await shutdownDbClient(); vi.unstubAllEnvs(); });
    discussionReadCostContracts();
});
