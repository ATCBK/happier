import { describe, expect, it } from 'vitest';
import { RunFollowUpdateNotificationV1Schema } from '@happier-dev/protocol/activity/webhookPayload';
import { createAccountNoticeArtifactFixture, createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { readAccountNoticeArtifactHeader, readOpenUsageNoticeArtifactHeader } from './usageNoticeArtifacts';

describe('private Account notice reader', () => {
    it('retains a Run Follow notice without misclassifying it as a legacy usage notice', () => {
        const notice = RunFollowUpdateNotificationV1Schema.parse({ topic: 'follow_update', follow: {
            original: { source: { kind: 'workflow_run', runId: 'run-1' }, revision: 2 },
            event: { kind: 'finished' },
        } });
        const artifact = createAccountNoticeArtifactFixture({ header: {
            source: { kind: 'host', topic: 'follow_update' }, page: undefined, notice,
        } });
        expect(readAccountNoticeArtifactHeader(artifact, 'account-a')?.notice).toEqual(notice);
        expect(readOpenUsageNoticeArtifactHeader(artifact, 'account-a')).toBeNull();
        expect(readOpenUsageNoticeArtifactHeader(createUsageNoticeArtifactFixture(), 'account-a'))
            .toMatchObject({ kind: 'usage_notice.v1', notice: { topic: 'connected_service_usage' } });
    });
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
