import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    subscribeHomeAccountChange,
    type HomeAccountChangeEvent,
} from '@/sync/runtime/orchestration/homeAccountChange';

function accountChangeAffectsWorkflowRunList(event: HomeAccountChangeEvent, runId?: string, source: 'workflow' | 'automation' = 'workflow'): boolean {
    return event.entityIds === undefined
        || event.entityIds.some((entityId) => runId === undefined
            ? entityId.startsWith(source === 'automation' ? 'automation:' : 'workflow-run:')
            : entityId === `workflow-run:${runId}`);
}

/**
 * Observe the incumbent Home Account-change wake for a visible Runs window
 * or one demanded exact Run. Invocation-only writes use this same wake.
 *
 * This does not interpret Run state or own synchronization: the existing list
 * query remains authoritative for filter membership, including attention.
 */
export function subscribeVisibleWorkflowRunListInvalidation(params: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    runId?: string;
    source?: 'workflow' | 'automation';
    isVisibleWindowLoaded: () => boolean;
    invalidate: (options: Readonly<{ summaryCurrent: boolean }>) => void;
}>): () => void {
    const unsubscribe = subscribeHomeAccountChange((event) => {
        if (!params.lifetime.isCurrent()) return;
        if (!areServerProfileIdentifiersEquivalent(event.serverId, params.lifetime.scope.serverId)) return;
        if (!accountChangeAffectsWorkflowRunList(event, params.runId, params.source)) return;
        if (!params.isVisibleWindowLoaded()) return;
        params.invalidate({ summaryCurrent: event.workflowRunsMaterialized === true });
    });
    const retirement = params.lifetime.onRetire(unsubscribe);
    return () => {
        retirement.dispose();
        unsubscribe();
    };
}
