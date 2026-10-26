import { APPROVAL_ARTIFACT_KINDS_V1, buildApprovalRequestArtifactHeaderV1,
    buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { StoredTargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { ServerFetch } from '@/sync/http/client';
import { executeApiTokenAction } from '@/sync/ops/actions/apiTokenActionTransport';

import type { DecryptedArtifact } from './artifactTypes';

const APPROVAL_PAGE_SIZE = 100;

type ApprovalListItem = Readonly<{ artifactId: string; sessionId?: string | null }>;
type ApprovalListPage = Readonly<{
    items: readonly ApprovalListItem[];
    nextCursor?: string | null;
}>;

/**
 * Project the mounted Session's public approval reads into the incumbent Artifact
 * presentation owner. The child credential never receives raw Account Artifact access.
 */
export async function fetchEmbedSessionApprovalArtifacts(input: Readonly<{
    request: ServerFetch;
    serverId: string;
    accountId: string;
    sessionId: string;
}>): Promise<DecryptedArtifact[]> {
    const transport = { request: input.request, target: { kind: 'session' as const, sessionId: input.sessionId } };
    const context = { surface: 'ui' as const, serverId: input.serverId };
    const items: ApprovalListItem[] = [];
    let cursor: string | null | undefined;
    do {
        const listed = await executeApiTokenAction(transport, 'approval.request.list', {
            status: 'open', limit: APPROVAL_PAGE_SIZE, ...(cursor ? { cursor } : {}),
        }, context);
        if (!listed.ok) throw Object.assign(new Error(listed.error), { code: listed.errorCode });
        const page = listed.result as ApprovalListPage;
        items.push(...page.items.filter(item => item.sessionId === input.sessionId));
        cursor = page.nextCursor;
    } while (cursor);

    const artifacts = await Promise.all(items.map(async (item): Promise<DecryptedArtifact | null> => {
        const read = await executeApiTokenAction(transport, 'approval.request.get', { artifactId: item.artifactId }, context);
        if (!read.ok || typeof read.result !== 'object' || read.result === null || !('request' in read.result)) return null;
        const builtIn = StoredApprovalRequestSchema.safeParse(read.result.request);
        const projected = builtIn.success ? {
            approval: builtIn.data,
            header: buildApprovalRequestArtifactHeaderV1(builtIn.data, { legacyServerId: input.serverId }),
            kindHint: APPROVAL_ARTIFACT_KINDS_V1.builtIn,
        } : (() => {
            const targetAction = StoredTargetActionApprovalRequestV1Schema.safeParse(read.result.request);
            return targetAction.success ? {
                approval: targetAction.data,
                header: buildTargetActionApprovalArtifactHeaderV1(targetAction.data),
                kindHint: APPROVAL_ARTIFACT_KINDS_V1.targetAction,
            } : null;
        })();
        if (!projected) return null;
        const { approval, header, kindHint } = projected;
        if (header.sessionId !== input.sessionId) return null;
        return {
            id: item.artifactId,
            sourceServerId: input.serverId,
            kind: 'other',
            kindHint,
            access: 'view',
            ownerAccountId: input.accountId,
            publicAudience: 'none',
            header,
            rawHeader: header,
            title: approval.summary,
            sessions: [input.sessionId],
            body: JSON.stringify(approval),
            headerVersion: 1,
            bodyVersion: 1,
            seq: 0,
            createdAt: approval.createdAtMs,
            updatedAt: approval.updatedAtMs,
            storageMode: 'plain',
            isDecrypted: true,
        } satisfies DecryptedArtifact;
    }));
    return artifacts.filter((artifact): artifact is DecryptedArtifact => artifact !== null);
}
