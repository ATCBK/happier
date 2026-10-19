import type { ConnectedServiceUsageNotificationV1 } from '@happier-dev/protocol/activity/webhookPayload';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { AccountNoticeArtifactHeaderV1Schema, AccountNoticeArtifactBodyV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

export const usageNoticeFixture = {
    topic: 'connected_service_usage', kind: 'credit_expiry', serviceId: 'happier.agent.codex',
    profileId: 'profile-a', issueFingerprint: 'credit-a',
    evidence: { recordId: 'paug_v1_record_a', creditId: 'credit-a', expiresAtMs: 9_000,
        observedAtMs: 2_000, previousObservedAtMs: 1_000 },
} satisfies ConnectedServiceUsageNotificationV1;

export function createUsageNoticeArtifactFixture(
    overrides: Partial<Extract<DecryptedArtifact, { isDecrypted: true }>> = {},
): Extract<DecryptedArtifact, { isDecrypted: true }> {
    const header = overrides.header ?? { v: 1, kind: 'usage_notice.v1',
        title: 'Reset credit expires soon', status: 'open', notice: usageNoticeFixture };
    return {
        id: 'notice-owned', ownerAccountId: 'account-a', access: 'owner', publicAudience: 'none',
        isDecrypted: true, title: header.title, header, rawHeader: header,
        body: JSON.stringify({ v: 1, notice: usageNoticeFixture }),
        headerVersion: 3, bodyVersion: 2, seq: 1, createdAt: 1_000, updatedAt: 2_000,
        ...overrides,
    };
}

export function createAccountNoticeArtifactFixture(
    overrides: Omit<Partial<Extract<DecryptedArtifact, { isDecrypted: true }>>, 'header'> & {
        header?: Partial<NonNullable<DecryptedArtifact['header']>>;
    } = {},
): Extract<DecryptedArtifact, { isDecrypted: true }> {
    const content = AccountNoticeArtifactBodyV1Schema.parse({ v: 1,
        source: { kind: 'plugin', pluginId: 'acme.review', itemId: 'review-42' },
        type: 'update', resolved: false, page: { pageId: 'reviews', subPath: '42' },
    });
    const header = AccountNoticeArtifactHeaderV1Schema.parse({ ...content,
        kind: 'account_notice.v1', title: 'Review requested', status: 'open', ...overrides.header,
    });
    return createUsageNoticeArtifactFixture({ ...overrides, header, rawHeader: header,
        body: overrides.body ?? JSON.stringify(AccountNoticeArtifactBodyV1Schema.parse({
            v: header.v, source: header.source, type: header.type, resolved: header.resolved,
            page: header.page, body: header.body, notice: header.notice,
        })),
    });
}
