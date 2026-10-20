import * as React from 'react';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import { buildDiscussionListAttention, type DiscussionListRow } from '@/activity/attention/buildDiscussionListAttention';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage, useArtifacts, useArtifactsLoaded } from '@/sync/domains/state/storage';

/** Demand only on an open Discussion list; no per-row reads or private-body hydration. */
export function useDiscussionListRows(scope: ServerAccountScope, items: readonly DiscussionOpenedSummaryV1[]): readonly DiscussionListRow[] {
    const artifacts = useArtifacts();
    const artifactsLoaded = useArtifactsLoaded();
    const artifactScope = storage(state => state.profileScope);
    const previous = React.useRef<readonly DiscussionListRow[]>([]);
    return React.useMemo(() => {
        const rows = buildDiscussionListAttention({ scope, artifactScope, artifactsLoaded, artifacts, items }, previous.current);
        previous.current = rows;
        return rows;
    }, [scope.serverId, scope.accountId, artifactScope, artifactsLoaded, artifacts, items]);
}
