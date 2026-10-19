import {
    readUsageNoticeArtifactV1,
    readAccountNoticeArtifactV1,
    AccountNoticeArtifactHeaderV1Schema,
    type UsageNoticeArtifactHeaderV1,
    type AccountNoticeArtifactHeaderV1,
} from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import type { DecryptedArtifact } from './artifactTypes';

export type OpenUsageNoticeArtifact = Readonly<{
    artifact: DecryptedArtifact;
    header: UsageNoticeArtifactHeaderV1;
}>;

export type AccountNoticeArtifact = Readonly<{ artifact: DecryptedArtifact; header: AccountNoticeArtifactHeaderV1 }>;

export function readAccountNoticeArtifactHeader(
    artifact: Parameters<typeof readOpenUsageNoticeArtifactHeader>[0],
    accountId: string | null | undefined,
): AccountNoticeArtifactHeaderV1 | null {
    if (!isPrivateOwnedNotice(artifact, accountId)) return null;
    const input = { header: artifact.rawHeader ?? artifact.header, body: artifact.body };
    const current = readAccountNoticeArtifactV1(input);
    if (current) return current;
    const legacy = readUsageNoticeArtifactV1(input);
    // Retained usage_notice.v1 is a stored-read adapter, not another item classifier or writer.
    return legacy ? AccountNoticeArtifactHeaderV1Schema.parse({
        v: 1, kind: 'account_notice.v1', title: legacy.title, status: legacy.status,
        type: 'update', resolved: false, source: { kind: 'host', topic: legacy.notice.topic },
        notice: legacy.notice, ...(legacy.excerpt === undefined ? {} : { excerpt: legacy.excerpt }),
    }) : null;
}

function isPrivateOwnedNotice(
    artifact: Parameters<typeof readOpenUsageNoticeArtifactHeader>[0], accountId: string | null | undefined,
): boolean {
    return Boolean(accountId && artifact.isDecrypted && artifact.draft !== true
        && artifact.ownerAccountId === accountId && artifact.access === 'owner' && artifact.publicAudience === 'none');
}

export function isOpenAccountNotice(header: AccountNoticeArtifactHeaderV1): boolean {
    return header.status === 'open' && !header.resolved;
}

export function isUnreadAccountNotice(header: AccountNoticeArtifactHeaderV1): boolean {
    return isOpenAccountNotice(header) && (header.type === 'decision' || header.type === 'approval'
        || header.type === 'blocked' || header.readAt === undefined);
}

/** Header content never establishes Account ownership or the authenticated audience. */
export function readOpenUsageNoticeArtifactHeader(
    artifact: Readonly<{ isDecrypted: boolean; ownerAccountId?: string; access?: string;
        publicAudience?: string; draft?: boolean; header?: unknown; rawHeader?: unknown; body?: unknown }>,
    accountId: string | null | undefined,
): UsageNoticeArtifactHeaderV1 | null {
    const header = readAccountNoticeArtifactHeader(artifact, accountId);
    return header && isOpenAccountNotice(header) && header.source.kind === 'host' && header.notice
        && header.notice.topic !== 'follow_update'
        ? { v: 1, kind: 'usage_notice.v1', title: header.title, status: header.status, notice: header.notice,
            ...(header.excerpt === undefined ? {} : { excerpt: header.excerpt }) } : null;
}
