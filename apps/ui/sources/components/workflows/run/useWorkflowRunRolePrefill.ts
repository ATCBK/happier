import * as React from 'react';
import type { RoleOverrideV1 } from '@happier-dev/protocol';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readWorkflowRunRolePrefill } from '@/sync/domains/workflows/workflowRunListActions';
import { useWorkflowAccountLifetime } from '../workflowAccountScope';

const EMPTY_OVERRIDES: readonly RoleOverrideV1[] = Object.freeze([]);

/** Review-local draft, seeded by FIN's existing accepted-run reader. No persisted role memory. */
export function useWorkflowRunRolePrefill(sourceArtifactId: string | null | undefined) {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const addressedLifetime = useWorkflowAccountLifetime();
    const lifetime = addressedLifetime === undefined ? activeLifetime : addressedLifetime;
    const scope = lifetime?.scope ?? null;
    const identity = JSON.stringify([scope?.serverId, scope?.accountId, sourceArtifactId]);
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const [state, setState] = React.useState<Readonly<{
        identity: string; status: 'ready' | 'loading' | 'failed'; overrides: readonly RoleOverrideV1[];
        lifetime: ActiveServerAccountScopeLifetime | null;
    }>>({ identity, lifetime, status: sourceArtifactId ? 'loading' : 'ready', overrides: EMPTY_OVERRIDES });
    React.useEffect(() => {
        if (!sourceArtifactId) {
            setState({ identity, lifetime, status: 'ready', overrides: EMPTY_OVERRIDES });
            return;
        }
        if (!lifetime) {
            setState({ identity, lifetime, status: 'failed', overrides: EMPTY_OVERRIDES });
            return;
        }
        const abort = new AbortController();
        const retirement = lifetime.onRetire(() => abort.abort());
        setState({ identity, lifetime, status: 'loading', overrides: EMPTY_OVERRIDES });
        void readWorkflowRunRolePrefill({ sourceArtifactId, accountId: lifetime.scope.accountId, signal: abort.signal, accountLifetime: lifetime })
            .then((overrides) => {
                if (!abort.signal.aborted && lifetime.isCurrent()) setState({ identity, lifetime, status: 'ready', overrides: overrides ?? EMPTY_OVERRIDES });
            }, () => {
                if (!abort.signal.aborted && lifetime.isCurrent()) setState({ identity, lifetime, status: 'failed', overrides: EMPTY_OVERRIDES });
            });
        return () => { abort.abort(); retirement.dispose(); };
    }, [attempt, identity, lifetime, sourceArtifactId]);
    const onChange = React.useCallback((overrides: readonly RoleOverrideV1[]) => {
        if (lifetime?.isCurrent()) setState({ identity, lifetime, status: 'ready', overrides });
    }, [identity, lifetime]);
    const current = state.identity === identity && state.lifetime === lifetime;
    return { overrides: current ? state.overrides : EMPTY_OVERRIDES,
        status: current ? state.status : sourceArtifactId ? 'loading' as const : 'ready' as const,
        onChange, retry };
}
