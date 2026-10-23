import { afterAll, beforeAll, describe } from 'vitest';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { discussionAttachmentContracts } from './discussionAttachments.testkit';

describe('Discussion committed private attachments (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-discussion-files-', initAuth: false, initEncrypt: true, initFiles: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });
    discussionAttachmentContracts();
});
