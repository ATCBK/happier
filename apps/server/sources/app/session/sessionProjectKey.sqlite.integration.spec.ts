import { afterAll, beforeAll, describe } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { sessionProjectKeyContractTests } from './sessionProjectKey.testkit';

describe('Session Project identity (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-project-key-', initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });
    sessionProjectKeyContractTests();
});
