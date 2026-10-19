import { describe, expect, it } from 'vitest';
import { createAccountNoticeArtifactFixture, createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { readAccountNoticeArtifactHeader } from './usageNoticeArtifacts';

describe('private Account notice reader', () => {
    it('normalizes a retained usage notice through the same host update type as current writes', () => {
        expect(readAccountNoticeArtifactHeader(createUsageNoticeArtifactFixture(), 'account-a')).toMatchObject({
            kind: 'account_notice.v1', source: { kind: 'host', topic: 'connected_service_usage' }, type: 'update', resolved: false,
        });
    });
    it('admits the paired owned notice and retains read/resolved facts without trusting its header for access', () => {
        const notice = createAccountNoticeArtifactFixture();
        expect(readAccountNoticeArtifactHeader(notice, 'account-a')).toMatchObject({
            source: { kind: 'plugin', pluginId: 'acme.review', itemId: 'review-42' }, type: 'update',
        });
        for (const override of [
            { ownerAccountId: 'account-b' }, { access: 'view' }, { publicAudience: 'public' },
            { isDecrypted: false }, { draft: true }, { body: '{}' },
        ]) expect(readAccountNoticeArtifactHeader({ ...notice, ...override }, 'account-a')).toBeNull();
        const resolved = createAccountNoticeArtifactFixture({ header: { resolved: true, readAt: 2_000 } });
        expect(readAccountNoticeArtifactHeader(resolved, 'account-a')).toMatchObject({ resolved: true, readAt: 2_000 });
    });
});
