import { afterAll, beforeAll, describe } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { sessionProjectKeyContractTests } from './sessionProjectKey.testkit';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Session Project identity (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = 'optional';
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });
    sessionProjectKeyContractTests();
});
