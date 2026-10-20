import { afterAll, beforeAll, describe, it } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { exerciseManagedProjectionVolume } from './managedProjectionVolume.testkit';

describe('managed projection volume on disposable PostgreSQL', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        process.env.HAPPIER_SERVER_IDENTITY_ID = `srv_${'a'.repeat(32)}`;
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });
    it('projects List, Create and Cancel without reading unrelated declarations', exerciseManagedProjectionVolume, 120_000);
});
