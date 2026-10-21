import * as React from 'react';
import type { WorkflowTriggerListRequestV1, WorkflowTriggerSetV1 } from '@happier-dev/protocol';

import { getStorage, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { serverAccountScopeKeySuffix, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createWorkflowTriggerChangeSelector, createWorkflowTriggerSetSelector } from '@/sync/store/domains/automations';
import { listWorkflowTriggerSets } from '@/sync/domains/workflows/workflowTriggerActions';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveHomeSettling } from '@/components/navigation/connectionStatus/HomeReachabilityGate';

const EMPTY_SETS: readonly WorkflowTriggerSetV1[] = [];

/** Read lifecycle only; the existing Account Automation projection remains the row owner. */
export function useWorkflowTriggerSets(request: WorkflowTriggerListRequestV1 | null, accountLifetime?: ServerAccountScopeLifetime | null) {
    const addressed = accountLifetime !== undefined;
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const lifetime = addressed ? accountLifetime ?? null : activeLifetime;
    const scope = lifetime?.scope ?? null;
    const scopeKey = scope ? serverAccountScopeKeySuffix(scope) : null;
    const workflow = request && 'workflow' in request ? request.workflow : null;
    const requestedScope = request && 'scope' in request ? request.scope : 'account_inline';
    const queryKey = request === null ? '' : workflow ? `workflow:${workflow}` : requestedScope;
    // Addressed reads for the focused Account share its canonical Automation
    // projection, including local Action receipts before a socket wake arrives.
    const focused = !addressed || Boolean(scope && activeLifetime?.isCurrent()
        && activeLifetime.scope.accountId === scope.accountId
        && areServerProfileIdentifiersEquivalent(activeLifetime.scope.serverId, scope.serverId));
    // The semantic query, not a caller's object allocation, owns the read lifetime.
    const readRequest = React.useMemo<WorkflowTriggerListRequestV1 | null>(() => queryKey === '' ? null
        : workflow === null ? { scope: requestedScope } : { workflow }, [queryKey, workflow, requestedScope]);
    const identity = React.useMemo(() => ({}), [queryKey, scopeKey, lifetime]);
    const selector = React.useMemo(() => focused ? createWorkflowTriggerSetSelector(queryKey, workflow !== null)
        : () => EMPTY_SETS, [focused, queryKey, workflow]);
    const sets = getStorage()(selector);
    const changeSelector = React.useMemo(() => !focused || queryKey === '' ? () => ''
        : createWorkflowTriggerChangeSelector(null, workflow, requestedScope === 'account_all'), [focused, queryKey, workflow, requestedScope]);
    const changeSignal = getStorage()(changeSelector);
    const [state, setState] = React.useState<{ identity: object; status: 'loading' | 'ready' | 'failed'; sets?: readonly WorkflowTriggerSetV1[] }>(
        () => ({ identity, status: request === null ? 'ready' : 'loading' }),
    );
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => !accountLifetime ? undefined : subscribeHomeAccountChange(event => {
        if (areServerProfileIdentifiersEquivalent(event.serverId, accountLifetime.scope.serverId)) setAttempt(value => value + 1);
    }), [accountLifetime]);
    React.useEffect(() => {
        if (readRequest === null || (addressed && !accountLifetime?.isCurrent())) return;
        // No Account scope yet is not a failed read: right after sign-in the page mounts before its Account
        // is established. The lifetime is a dependency, so the read starts, and settles, once it arrives.
        if (!lifetime) {
            setState(current => current.identity === identity ? current : { identity, status: 'loading' });
            return;
        }
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => { controller.abort(); setState({ identity, status: 'failed' }); });
        // A settled read keeps its answer while it refreshes (a change signal or a retry after
        // success): the store still holds the last-known sets, so nothing reverts to loading.
        setState((current) => current.identity === identity
            ? current.status === 'ready' ? current : { ...current, status: 'loading' }
            : { identity, status: 'loading' });
        listWorkflowTriggerSets(readRequest, { signal: controller.signal,
            ...(addressed ? { accountLifetime } : {}) }).then(result => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setState({ identity, status: 'ready', ...(addressed ? { sets: result } : {}) });
        }).catch(() => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setState(current => ({
                ...(current.identity === identity ? current : {}), identity, status: 'failed',
            }));
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [attempt, changeSignal, identity, readRequest, addressed, accountLifetime, lifetime]);
    const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
    // A read that failed while the Home was still being reached (right after sign-in or a restart) has not
    // settled into a failure: it reads as loading, and is read again once the Home has answered.
    const homeSettling = useActiveHomeSettling() && !addressed;
    const failedRef = React.useRef(false);
    failedRef.current = state.identity === identity && state.status === 'failed';
    const wasSettling = React.useRef(false);
    React.useEffect(() => {
        if (wasSettling.current && !homeSettling && failedRef.current) setAttempt((value) => value + 1);
        wasSettling.current = homeSettling;
    }, [homeSettling]);
    const status = state.identity !== identity ? 'loading' as const
        : state.status === 'failed' && homeSettling ? 'loading' as const : state.status;
    return { sets: request === null ? EMPTY_SETS : addressed ? state.identity === identity && accountLifetime?.isCurrent()
        ? focused ? sets : state.sets ?? EMPTY_SETS : EMPTY_SETS : sets, status: request === null ? 'ready' as const : status, retry };
}
