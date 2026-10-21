import * as React from 'react';
import type { RegistryActionIdV1 } from '@happier-dev/protocol/registries';
import { readRegistryFailureStatus, type RegistryFailureStatus } from './describeRegistrySourceStatus';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { invalidateUiRegistryItemMemoV1 } from './registryHostDeps';

class RegistryReadFailure extends Error {
    constructor(message: string, readonly status: RegistryFailureStatus | null) { super(message); }
}

/** Reads share the mounted approval/currentness owner and retain last-known data during refresh. */
export function useRegistryActionRead<T>(actionId: RegistryActionIdV1, input: unknown,
    parse: (value: unknown, previous: T | null) => T, revision?: unknown, enabled = true): {
    scopeKey: string;
    inputKey: string;
    revision: unknown;
    value: T | null;
    error: string | null;
    status: RegistryFailureStatus | null;
    loading: boolean;
    stale: boolean;
    refresh: () => Promise<void>;
    execution: ReturnType<typeof useMountedActionExecution>;
    scope: ReturnType<typeof useAccountSettingsScope>;
} {
    const scope = useAccountSettingsScope();
    const execution = useMountedActionExecution(scope);
    const scopeKey = JSON.stringify([scope?.serverId, scope?.accountId]);
    const inputKey = JSON.stringify(input);
    const args = React.useMemo(() => JSON.parse(inputKey) as unknown, [inputKey]);
    const parser = React.useRef(parse);
    parser.current = parse;
    const [state, setState] = React.useState<{ scopeKey: string; inputKey: string; revision: unknown; value: T | null; loading: boolean; error: string | null; status: RegistryFailureStatus | null }>({
        scopeKey, inputKey, revision, value: null, loading: enabled, error: null, status: null,
    });
    const latest = React.useRef(state);
    latest.current = state;
    const generation = React.useRef(0);
    const load = React.useCallback(async (force: boolean) => {
        const request = ++generation.current;
        if (!enabled || !execution.ready) return;
        const previous = latest.current;
        if (force && actionId === 'registries.items.read' && scope) invalidateUiRegistryItemMemoV1(scope, args);
        setState(previous => {
            // A source-list revision refreshes descriptors, not their Account authority. Keep this exact
            // list mounted (including mutation receipts); item reads still withdraw on source changes.
            const sameAuthority = previous.scopeKey === scopeKey && (Object.is(previous.revision, revision)
                || (actionId === 'registries.sources.list' && previous.inputKey === inputKey));
            return { scopeKey, revision: sameAuthority ? previous.revision : revision, inputKey: sameAuthority ? previous.inputKey : inputKey,
                value: sameAuthority ? previous.value : null, loading: true, error: null, status: null };
        });
        try {
            const value = force && actionId === 'registries.items.list' && args && typeof args === 'object'
                ? { ...args, refresh: true } : args;
            const result = await execution.execute(actionId, value);
            if (request !== generation.current || !execution.isCurrent()) return;
            if (!result.ok) throw new RegistryReadFailure(result.error, readRegistryFailureStatus(result.details));
            const parsed = parser.current(result.result, previous.scopeKey === scopeKey && previous.inputKey === inputKey
                && Object.is(previous.revision, revision) ? previous.value : null);
            setState(previous => ({ scopeKey, inputKey, revision, value: previous.scopeKey === scopeKey && Object.is(previous.revision, revision)
                && sameStrictJsonValue(previous.value, parsed)
                ? previous.value : parsed, loading: false, error: null, status: null }));
        } catch (error) {
            if (request !== generation.current || !execution.isCurrent()) return;
            setState(previous => {
                const sameAuthority = previous.scopeKey === scopeKey && (Object.is(previous.revision, revision)
                    || (actionId === 'registries.sources.list' && previous.inputKey === inputKey));
                return { scopeKey, revision: sameAuthority ? previous.revision : revision, inputKey: sameAuthority ? previous.inputKey : inputKey,
                    value: sameAuthority ? previous.value : null, loading: false,
                    error: error instanceof Error ? error.message : 'registry_unavailable',
                    status: error instanceof RegistryReadFailure ? error.status : null };
            });
        }
    }, [actionId, args, enabled, execution.execute, execution.isCurrent, execution.ready, scopeKey, scope, inputKey, revision]);
    const refresh = React.useCallback(() => load(true), [load]);
    React.useEffect(() => {
        void load(false);
        return () => { generation.current += 1; };
    }, [load, revision]);
    const current = state.scopeKey === scopeKey && (Object.is(state.revision, revision)
        || (actionId === 'registries.sources.list' && state.inputKey === inputKey))
        ? state : { scopeKey, inputKey, revision, value: null, loading: enabled, error: null, status: null };
    // Credential retirement precedes the Sync store's next Account projection.
    // Never disclose that previous projection through an unbound mounted caller.
    return { ...current, value: execution.ready ? current.value : null, error: execution.ready ? current.error : null,
        status: execution.ready ? current.status : null,
        loading: enabled && (current.loading || !execution.ready),
        stale: current.inputKey !== inputKey || !Object.is(current.revision, revision), refresh, execution, scope };
}
