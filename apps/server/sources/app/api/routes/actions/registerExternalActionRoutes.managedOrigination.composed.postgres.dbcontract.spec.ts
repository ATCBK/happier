// Run the same real CLI/Home/approval and exact QB56-input composition on the
// disposable PostgreSQL harness, rather than maintaining a second fixture.
import { beforeAll } from 'vitest';
import './registerExternalActionRoutes.managedOrigination.composed.integration.spec';

beforeAll(() => {
    if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
        || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
        throw new Error('Use only the disposable PostgreSQL DB-contract harness');
    }
});
