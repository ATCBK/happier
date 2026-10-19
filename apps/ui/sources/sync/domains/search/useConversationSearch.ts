import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { MemorySearchQueryV1 } from '@happier-dev/protocol/memory/memorySearch';
import { isMemoryExternalTranscriptSearchHitV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { searchConversationsForAccount } from '@/sync/ops/searchConversations';
import { mergeConversationSearchHits, type ConversationSearchResult, type ConversationSearchSource } from './searchConversations';
import { useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

/** Data-only owner for explicit scans, coverage and producer-qualified Search more. */
export function useConversationSearch(input: Readonly<{
    query: MemorySearchQueryV1; machineIds?: readonly string[];
    mode: 'indexed' | 'standard' | 'auto'; accountLifetime: ServerAccountScopeLifetime | null;
    providers: Readonly<{ homeSessions: boolean; daemonEnabled: boolean }>; enabled?: boolean;
    source?: ConversationSearchSource; includeThreads?: boolean;
}>) {
    const presentationActive = useLayoutPresentationActive();
    const enabled = input.enabled !== false && presentationActive;
    // Per-request admission belongs to the Account operation. A successful Retry
    // must not invalidate its own still-running search as it restores reachability.
    const selectedMachineIds = input.machineIds === undefined ? undefined : [...new Set(input.machineIds)].sort();
    const intentKey = JSON.stringify([input.accountLifetime?.scope, input.query, selectedMachineIds, input.mode, input.providers,
        enabled, input.source && [input.source.agentId, input.source.sourceKey, input.source.source, input.source.contentSearch], input.includeThreads]);
    // Presence is admission input at each Account operation, not new search
    // intent. Heartbeats and inventory refreshes must not erase hits or cursors.
    const presence = useMachinePresenceMembership(input.accountLifetime?.scope.serverId ?? null);
    // Empty-query reads only discover which sources can be searched. Refresh
    // that admission when presence recovers, without retiring an actual query's
    // hits, Stop state or producer cursors on background presence changes.
    const availabilityKey = input.query.query.trim().length === 0
        ? JSON.stringify(selectedMachineIds === undefined ? presence.onlineMachineIds
            : presence.onlineMachineIds.filter(id => selectedMachineIds.includes(id)))
        : null;
    const key = JSON.stringify([intentKey, availabilityKey]);
    const [revision, reload] = React.useReducer(value => value + 1, 0);
    const [state, setState] = React.useState<Readonly<{
        key: string; result: ConversationSearchResult | null; loading: boolean; error: unknown; cancelled?: boolean;
    }>>({ key, result: null, loading: false, error: null });
    const request = React.useRef<AbortController | null>(null);
    const publishedLifetime = React.useRef<ServerAccountScopeLifetime | null>(null);
    const currentInput = React.useRef({ ...input, enabled });
    const currentResult = React.useRef(state.result);
    currentResult.current = state.key === key ? state.result : null;
    const explicitRetry = React.useRef(false);
    const stopped = React.useRef<Readonly<{ intentKey: string; lifetime: ServerAccountScopeLifetime }> | null>(null);
    currentInput.current = { ...input, enabled };
    React.useEffect(() => {
        const lifetime = input.accountLifetime;
        publishedLifetime.current = lifetime;
        const controller = new AbortController();
        request.current = controller;
        if (!lifetime?.isCurrent() || !enabled) {
            setState({ key, result: null, loading: false, error: null });
            return () => controller.abort();
        }
        const retirement = lifetime.onRetire(() => { request.current?.abort(); setState({ key, result: null, loading: false, error: null }); });
        // Availability may change after Stop. Only a new search intent or the
        // person's Retry can admit another scan under this Account lifetime.
        if (stopped.current?.intentKey === intentKey && stopped.current.lifetime === lifetime) {
            controller.abort();
            setState(previous => ({ ...previous, key, loading: false, cancelled: true }));
            return () => { request.current?.abort(); retirement.dispose(); };
        }
        stopped.current = null;
        setState({ key, result: null, loading: true, error: null });
        const retryUnreachableMachines = explicitRetry.current;
        explicitRetry.current = false;
        void searchConversationsForAccount({ ...currentInput.current, accountLifetime: lifetime, signal: controller.signal, retryUnreachableMachines,
            onSources: sources => {
                if (controller.signal.aborted || !lifetime.isCurrent()) return;
                // Source admission precedes the completed per-machine status.
                // Do not fabricate standard-search permission during that gap.
                setState(previous => ({ ...previous, result: { hits: [], machines: [], ...previous.result, sources } }));
            },
            onProgress: result => {
                if (controller.signal.aborted || !lifetime.isCurrent()) return;
                setState(previous => ({ ...previous, result }));
            },
        })
            .then(result => { if (!controller.signal.aborted && lifetime.isCurrent()) setState({ key, result, loading: false, error: null }); })
            .catch(error => { if (!controller.signal.aborted && lifetime.isCurrent()) setState({ key, result: null, loading: false, error }); });
        return () => { request.current?.abort(); retirement.dispose(); };
    }, [key, input.accountLifetime, revision]);
    const loadMore = React.useCallback(async (target: NonNullable<ConversationSearchResult['continuations']>[number]
        | NonNullable<ConversationSearchResult['failures']>[number]) => {
        const current = currentInput.current;
        if (!current.enabled || !current.accountLifetime?.isCurrent() || !request.current) return;
        const continuation = 'cursor' in target ? target : undefined;
        const failure = 'errorCode' in target ? target : undefined;
        if (failure && !failure.retryable) return;
        // A failed continuation retries its original cursor; a failed first page
        // reuses this same owner with an exact source and no fabricated cursor.
        const sourceContinuation = continuation ?? currentResult.current?.continuations?.find(value =>
            value.machineId === target.machineId && value.sourceKey === target.sourceKey);
        // The published producer already supplies the exact native source for
        // its cursor. Do not rediscover every source before requesting its page.
        // The Account operation and daemon still perform current admission.
        const source = target.sourceKey === undefined ? current.source : current.source ?? currentResult.current?.sources?.find(value =>
            value.machineId === target.machineId && value.sourceKey === target.sourceKey && (!failure || value.agentId === failure.agentId));
        const retryCancelledPage = request.current.signal.aborted;
        // Search more is also Retry for a stopped continuation. Keep its cursor
        // and published hits, but give the resumed page fresh cancellation custody.
        const controller = retryCancelledPage ? new AbortController() : request.current;
        request.current = controller;
        stopped.current = null;
        setState(previous => ({ ...previous, loading: true, error: null, cancelled: false }));
        try {
            const page = await searchConversationsForAccount({ ...current, accountLifetime: current.accountLifetime,
                ...(source ? { source } : {}),
                ...(failure ? { mode: 'standard', retrySource: failure } : {}),
                continuation: sourceContinuation, signal: controller.signal, retryUnreachableMachines: Boolean(failure) || retryCancelledPage });
            if (controller.signal.aborted || !current.accountLifetime.isCurrent()) return;
            setState(previous => {
                if (previous.key !== key || !previous.result) return previous;
                const sameProducer = (value: Readonly<{ machineId: string | null; sourceKey?: string }>) => value.machineId === target.machineId && value.sourceKey === target.sourceKey;
                const failures = [...(previous.result.failures ?? []).filter(value => !sameProducer(value)), ...(page.failures ?? [])];
                const continuations = [...(previous.result.continuations ?? []).filter(value => !sameProducer(value)), ...(page.continuations ?? [])];
                return { key, loading: false, error: null, result: { ...previous.result,
                    ...(page.homeStatus !== undefined ? { homeStatus: page.homeStatus } : {}),
                    hits: mergeConversationSearchHits([...previous.result.hits.filter(row => {
                        if (row.mode === 'standard') return !page.resetSources?.some(source => row.machineId === source.machineId && row.sourceKey === source.sourceKey);
                        const hit = row.hit;
                        return !isMemoryExternalTranscriptSearchHitV1(hit) || !page.completedStandardSources?.some(source =>
                            row.machineId === source.machineId && hit.source.agentId === source.agentId && hit.source.sourceKey === source.sourceKey);
                    }), ...page.hits], previous.result.sources),
                    machines: previous.result.machines.map(machine => {
                        const next = page.machines.find(value => value.machineId === machine.machineId);
                        return { ...machine, ...next, ...(next?.status === 'ok' && (failures.some(value => value.machineId === machine.machineId)
                            || continuations.some(value => value.machineId === machine.machineId)) ? { status: 'partial' as const } : {}) };
                    }),
                    failures, continuations,
                } };
            });
        } catch (error) { if (!controller.signal.aborted) setState(previous => ({ ...previous, loading: false, error })); }
    }, [key]);
    return { ...(state.key === key && publishedLifetime.current === input.accountLifetime && input.accountLifetime?.isCurrent() ? state : { result: null, loading: false, error: null, cancelled: false }),
        loadMore, reload: () => { stopped.current = null; explicitRetry.current = true; reload(); }, cancel: () => {
            if (input.accountLifetime) stopped.current = { intentKey, lifetime: input.accountLifetime };
            request.current?.abort();
            setState(previous => ({ ...previous, loading: false, cancelled: true }));
        } };
}
