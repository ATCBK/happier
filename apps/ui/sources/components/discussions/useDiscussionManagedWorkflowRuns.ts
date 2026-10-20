import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions';
import { useContextManagedWorkflowRuns } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/** Demand-mounted timeline data, including Runs that have not published their first reply yet. */
export function useDiscussionManagedWorkflowRuns(params: Readonly<{
    discussion: DiscussionAddressV1;
    accountLifetime: ServerAccountScopeLifetime;
    enabled?: boolean;
}>) {
    return useContextManagedWorkflowRuns({ resource: { kind: 'discussion', id: params.discussion.discussionId },
        serverId: params.discussion.serverId, accountLifetime: params.accountLifetime,
        enabled: params.enabled !== false && areServerProfileIdentifiersEquivalent(params.accountLifetime.scope.serverId, params.discussion.serverId) });
}
