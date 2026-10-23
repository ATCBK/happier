import { afterAll, beforeAll, describe } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { discussionReadCostContracts } from './discussionReadCosts.testkit';

describe('Discussion read demand (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-read-costs-', initAuth: false, initEncrypt: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    discussionReadCostContracts();
});
