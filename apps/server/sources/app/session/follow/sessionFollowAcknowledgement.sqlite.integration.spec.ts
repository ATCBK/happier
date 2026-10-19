import { afterAll, beforeAll, describe, it } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { assertConcurrentFailedTurnRouteAcknowledgements } from './sessionFollowAcknowledgement.testkit';

describe('Follow route ACK socket composition on SQLite', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-follow-route-ack-', sqliteConnectionLimit: 1,
            env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: '1' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });
    it('commits both concurrent routes for one accepted input and a failed source turn',
        async () => await assertConcurrentFailedTurnRouteAcknowledgements());
});
