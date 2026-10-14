import * as React from 'react';
import type { MemorySearchQueryV1 } from '@happier-dev/protocol/memory/memorySearch';
import { isMemoryExternalTranscriptSearchHitV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { searchConversationsForAccount } from '@/sync/ops/searchConversations';
import { useMachineListForServer } from '@/sync/domains/state/storage';
import { mergeConversationSearchHits, type ConversationSearchResult, type ConversationSearchSource } from './searchConversations';

/** Data-only owner for explicit scans, coverage and producer-qualified Search more. */
export function useConversationSearch(input: Readonly<{
    query: MemorySearchQueryV1; machineIds?: readonly string[];
    mode: 'indexed' | 'standard' | 'auto'; accountLifetime: ServerAccountScopeLifetime | null;
    providers: Readonly<{ homeSessions: boolean; daemonEnabled: boolean }>; enabled?: boolean;
    source?: ConversationSearchSource; includeThreads?: boolean;
}>) {
    const machines = useMachineListForServer(input.accountLifetime?.scope.serverId ?? '');
    // Per-request admission belongs to the Account operation. A successful Retry
    // must not invalidate its own still-running search as it restores reachability.
    const selectedMachineIds = input.machineIds === undefined ? undefined : [...new Set(input.machineIds)].sort();
    const intentKey = JSON.stringify([input.accountLifetime?.scope, input.query, selectedMachineIds, input.mode, input.providers,
        input.enabled, input.source && [input.source.agentId, input.source.sourceKey, input.source.source, input.source.contentSearch], input.includeThreads]);
    const availability = selectedMachineIds === undefined
        ? (machines ?? []).map(machine => [machine.id, machine.active] as const).sort(([left], [right]) => left.localeCompare(right))
        : selectedMachineIds.map(id => [id, machines?.find(machine => machine.id === id)?.active ?? false]);
    const key = JSON.stringify([intentKey, availability]);
    const [revision, reload] = React.useReducer(value => value + 1, 0);
    const [state, setState] = React.useState<Readonly<{
        key: string; result: ConversationSearchResult | null; loading: boolean; error: unknown; cancelled?: boolean;
    }>>({ key, result: null, loading: false, error: null });
    const request = React.useRef<AbortController | null>(null);
    const publishedLifetime = React.useRef<ServerAccountScopeLifetime | null>(null);
    const currentInput = React.useRef(input);
    const explicitRetry = React.useRef(false);
    const stopped = React.useRef<Readonly<{ intentKey: string; lifetime: ServerAccountScopeLifetime }> | null>(null);
    currentInput.current = input;
    React.useEffect(() => {
        const lifetime = input.accountLifetime;
        publishedLifetime.current = lifetime;
        const controller = new AbortController();
        request.current = controller;
        if (!lifetime?.isCurrent() || input.enabled === false) {
            setState({ key, result: null, loading: false, error: null });
            return () => controller.abort();
        }
        const retirement = lifetime.onRetire(() => { controller.abort(); setState({ key, result: null, loading: false, error: null }); });
        // Availability may change after Stop. Only a new search intent or the
        // person's Retry can admit another scan under this Account lifetime.
        if (stopped.current?.intentKey === intentKey && stopped.current.lifetime === lifetime) {
            controller.abort();
            setState(previous => ({ ...previous, key, loading: false, cancelled: true }));
            return () => retirement.dispose();
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
        return () => { controller.abort(); retirement.dispose(); };
    }, [key, input.accountLifetime, revision]);
    const loadMore = React.useCallback(async (continuation: NonNullable<ConversationSearchResult['continuations']>[number]) => {
        const current = currentInput.current;
        const controller = request.current;
        if (!current.accountLifetime?.isCurrent() || !controller || controller.signal.aborted) return;
        setState(previous => ({ ...previous, loading: true }));
        try {
            const page = await searchConversationsForAccount({ ...current, accountLifetime: current.accountLifetime,
                continuation, signal: controller.signal });
            if (controller.signal.aborted || !current.accountLifetime.isCurrent()) return;
            setState(previous => {
                if (previous.key !== key || !previous.result) return previous;
                const sameProducer = (value: typeof continuation) => value.machineId === continuation.machineId && value.sourceKey === continuation.sourceKey;
                return { key, loading: false, error: null, result: { ...previous.result,
                    ...(page.homeStatus !== undefined ? { homeStatus: page.homeStatus } : {}),
                    hits: mergeConversationSearchHits([...previous.result.hits.filter(row => {
                        if (row.mode === 'standard') return !page.resetSources?.some(source => row.machineId === source.machineId && row.sourceKey === source.sourceKey);
                        const hit = row.hit;
                        return !isMemoryExternalTranscriptSearchHitV1(hit) || !page.completedStandardSources?.some(source =>
                            row.machineId === source.machineId && hit.source.agentId === source.agentId && hit.source.sourceKey === source.sourceKey);
                    }), ...page.hits]),
                    machines: previous.result.machines.map(machine => page.machines.find(next => next.machineId === machine.machineId) ?? machine),
                    continuations: [...(previous.result.continuations ?? []).filter(value => !sameProducer(value)), ...(page.continuations ?? [])],
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
