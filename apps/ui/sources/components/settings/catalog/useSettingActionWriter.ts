import * as React from 'react';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import type { SettingRef, SettingValue } from './settingDeclarations';

export type SettingActionAddress = Pick<SettingRef, 'anchor'> & Readonly<{ key?: string }>;

/** Exact declared-setting ingress; the mounted Action owner retains admission and approval. */
export function useSettingActionWriter(options: Readonly<{ serverId?: string }> = {}) {
    const scope = getStorage()(state => state.settingsScope);
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [scope]);
    const mounted = useMountedActionExecution(scope);
    const serverId = options.serverId;
    const isCurrent = React.useCallback(() => Boolean(scope && lifetime?.isCurrent()
        && areAccountSettingsScopesEqual(scope, lifetime.scope)
        && areAccountSettingsScopesEqual(scope, getStorage().getState().settingsScope)
        && (serverId === undefined || selectActiveServerAccountScopeForServer(scope, serverId))
        && mounted.isCurrent()), [lifetime, mounted.isCurrent, scope, serverId]);
    const write = React.useCallback(async (setting: SettingActionAddress, value: SettingValue,
        operation?: Readonly<{ signal?: AbortSignal }>): Promise<ActionExecuteResult> => {
        if (!lifetime || !isCurrent()) {
            return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        }
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        const cancellation = mergeAbortSignals([controller.signal, operation?.signal]);
        try {
            return await mounted.execute('settings.set', { anchor: setting.anchor, ...(setting.key !== undefined ? { key: setting.key } : {}), value }, { signal: cancellation.signal });
        } finally {
            cancellation.dispose();
            retirement.dispose();
        }
    }, [isCurrent, lifetime, mounted.execute]);
    return React.useMemo(() => Object.assign(write, { isCurrent }), [isCurrent, write]);
}
