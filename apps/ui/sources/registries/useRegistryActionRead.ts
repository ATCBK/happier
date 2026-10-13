import * as React from 'react';
import type { RegistryActionIdV1 } from '@happier-dev/protocol/registries';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { invalidateUiRegistryItemMemoV1 } from './registryHostDeps';

/** Reads share the mounted approval/currentness owner and retain last-known data during refresh. */
export function useRegistryActionRead<T>(actionId: RegistryActionIdV1, input: unknown,
    parse: (value: unknown, previous: T | null) => T, revision?: unknown, enabled = true) {
    const scope = useAccountSettingsScope();
    const execution = useMountedActionExecution(scope);
    const scopeKey = JSON.stringify([scope?.serverId, scope?.accountId]);
    const inputKey = JSON.stringify(input);
    const args = React.useMemo(() => JSON.parse(inputKey) as unknown, [inputKey]);
    const parser = React.useRef(parse);
    parser.current = parse;
    const [state, setState] = React.useState<{ scopeKey: string; inputKey: string; revision: unknown; value: T | null; loading: boolean; error: string | null }>({
        scopeKey, inputKey, revision, value: null, loading: enabled, error: null,
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
            const sameAuthority = previous.scopeKey === scopeKey && Object.is(previous.revision, revision);
            return { scopeKey, revision, inputKey: sameAuthority ? previous.inputKey : inputKey,
                value: sameAuthority ? previous.value : null, loading: true, error: null };
        });
        try {
            const value = force && actionId === 'registries.items.list' && args && typeof args === 'object'
                ? { ...args, refresh: true } : args;
            const result = await execution.execute(actionId, value);
            if (request !== generation.current || !execution.isCurrent()) return;
            if (!result.ok) throw new Error(result.error);
            const parsed = parser.current(result.result, previous.scopeKey === scopeKey && previous.inputKey === inputKey
                && Object.is(previous.revision, revision) ? previous.value : null);
            setState(previous => ({ scopeKey, inputKey, revision, value: previous.scopeKey === scopeKey && Object.is(previous.revision, revision)
                && sameStrictJsonValue(previous.value, parsed)
                ? previous.value : parsed, loading: false, error: null }));
        } catch (error) {
            if (request !== generation.current || !execution.isCurrent()) return;
            setState(previous => {
                const sameAuthority = previous.scopeKey === scopeKey && Object.is(previous.revision, revision);
                return { scopeKey, revision, inputKey: sameAuthority ? previous.inputKey : inputKey,
                    value: sameAuthority ? previous.value : null, loading: false,
                    error: error instanceof Error ? error.message : 'registry_unavailable' };
            });
        }
    }, [actionId, args, enabled, execution.execute, execution.isCurrent, execution.ready, scopeKey, scope, inputKey, revision]);
    const refresh = React.useCallback(() => load(true), [load]);
    React.useEffect(() => {
        void load(false);
        return () => { generation.current += 1; };
    }, [load, revision]);
    const current = state.scopeKey === scopeKey && Object.is(state.revision, revision)
        ? state : { scopeKey, inputKey, revision, value: null, loading: enabled, error: null };
    // Credential retirement precedes the Sync store's next Account projection.
    // Never disclose that previous projection through an unbound mounted caller.
    return { ...current, value: execution.ready ? current.value : null, error: execution.ready ? current.error : null,
        loading: enabled && (current.loading || !execution.ready), stale: current.inputKey !== inputKey, refresh, execution, scope };
}
