import { afterAll, beforeAll, describe, it } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { exerciseManagedProjectionVolume } from './managedProjectionVolume.testkit';

describe('managed projection volume on disposable SQLite', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-managed-projection-', initEncrypt: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: `srv_${'a'.repeat(32)}` } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });
    it('projects List, Create and Cancel without reading unrelated declarations', exerciseManagedProjectionVolume, 120_000);
});
