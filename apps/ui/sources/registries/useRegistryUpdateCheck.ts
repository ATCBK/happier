import * as React from 'react';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, type RegistryUpdateCheckResultV1, type RegistryKindV1 } from '@happier-dev/protocol/registries';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';

export type RegistryUpdateCheckState = Readonly<{
    checking: boolean;
    /** Last complete check; an unchecked item cannot advance this freshness fact. */
    checkedAt: number | null;
    failed: boolean;
    code: string | null;
    /** Latest attempt, including the per-item source failures the tracker deliberately does not persist. */
    results: RegistryUpdateCheckResultV1['results'];
}>;
const EMPTY_CHECK: RegistryUpdateCheckState = Object.freeze({ checking: false, checkedAt: null, failed: false, code: null, results: [] });

/** Transient user-requested checks, shared by Updates and the item detail; no schedule or durable failure state. */
export function useRegistryUpdateCheck(input: Readonly<{
    scopeKey: string;
    execute: MountedAuthoringActionExecute;
    isCurrent: () => boolean;
    kind: RegistryKindV1;
    keys?: readonly string[];
    retry: () => void;
}>) {
    const { scopeKey, execute, isCurrent, kind, retry } = input;
    const keysKey = JSON.stringify(input.keys ?? null);
    const [state, setState] = React.useState(() => ({ key: scopeKey, check: EMPTY_CHECK }));
    const currentKey = React.useRef(scopeKey);
    currentKey.current = scopeKey;
    const checkNow = React.useCallback(async () => {
        const current = () => currentKey.current === scopeKey && isCurrent();
        if (!current()) return;
        setState(previous => ({ key: scopeKey, check: { ...(previous.key === scopeKey ? previous.check : EMPTY_CHECK), checking: true } }));
        try {
            const keys: string[] | null = JSON.parse(keysKey);
            const result = await execute('registries.updates.check', { kind, ...(keys ? { keys } : {}) });
            if (!current()) return;
            const parsed = result.ok ? REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].safeParse(result.result) : null;
            setState(previous => {
                const before = previous.key === scopeKey ? previous.check : EMPTY_CHECK;
                if (!parsed?.success) return { key: scopeKey, check: { ...before, checking: false, failed: true,
                    code: result.ok ? 'invalid_action_output' : result.errorCode ?? result.error } };
                const failures = parsed.data.results.flatMap(item => item.upstream.state === 'unchecked' ? [item.upstream.reason.state] : []);
                return { key: scopeKey, check: { checking: false,
                    checkedAt: failures.length ? before.checkedAt : parsed.data.checkedAt,
                    failed: failures.length > 0, code: failures.length ? [...new Set(failures)].join(',') : null, results: parsed.data.results } };
            });
            retry();
        } catch (error) {
            if (current()) setState(previous => ({ key: scopeKey, check: { ...(previous.key === scopeKey ? previous.check : EMPTY_CHECK),
                checking: false, failed: true, code: error instanceof Error ? error.message : 'unknown' } }));
        }
    }, [scopeKey, execute, isCurrent, kind, keysKey, retry]);
    return { check: state.key === scopeKey ? state.check : EMPTY_CHECK, checkNow };
}
