import * as React from 'react';
import type { Settings } from '@/sync/domains/settings/settings';
import type { ServerCredentialAccountScopeBinding, ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { subscribeAccountSettingsPersistenceMutations } from '@/sync/domains/state/accountSettingsPersistence';
import { storage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

export type ManagedMachineAccountSettings = Pick<Settings, 'machineRetentionDefaultsV1' | 'managedMachineCreationEnabled'>;
type SettingsState = Readonly<{
    scopeKey: string; accountId: string | null; settings: ManagedMachineAccountSettings | null; loading: boolean; error: string | null;
}>;
const NO_SETTINGS = Object.freeze({ settings: null, loading: false, error: null });

/**
 * Narrow display projection over the canonical exact-Account settings reader, not another settings store.
 * An exact Home credential/URL refresh can retire the binding and bind the same Account again (the resolution stays
 * `bound` meanwhile): the last answer stays while the replacement reads. Another Account never sees it.
 */
export function useManagedMachineAccountSettings(binding: ServerCredentialAccountScopeBinding | null | undefined,
    resolution: ServerCredentialAccountScopeResolution): Readonly<{
    settings: ManagedMachineAccountSettings | null; loading: boolean; error: string | null;
}> {
    const scopeKey = JSON.stringify([binding?.serverId, binding?.accountId, binding?.revision]);
    const [state, setState] = React.useState<SettingsState>({ scopeKey: '', accountId: null, settings: null, loading: false, error: null });
    const [revision, refresh] = React.useReducer(value => value + 1, 0);

    React.useEffect(() => {
        if (!binding) return;
        const unsubscribeHome = subscribeHomeAccountChange(event => {
            if (event.accountSettingsAffects === false) return;
            if (areServerProfileIdentifiersEquivalent(event.serverId, binding.serverId) && binding.isCurrent()) refresh();
        });
        const unsubscribePersistence = subscribeAccountSettingsPersistenceMutations(scope => {
            if (areAccountSettingsScopesEqual(scope, binding.scope) && binding.isCurrent()) refresh();
        });
        const unsubscribeStorage = storage.subscribe((next, previous) => {
            if (binding.isCurrent() && areAccountSettingsScopesEqual(next.settingsScope, binding.scope)
                && (next.settings.managedMachineCreationEnabled !== previous.settings.managedMachineCreationEnabled
                    || next.settings.machineRetentionDefaultsV1 !== previous.settings.machineRetentionDefaultsV1
                    || !areAccountSettingsScopesEqual(previous.settingsScope, binding.scope))) refresh();
        });
        return () => { unsubscribeHome(); unsubscribePersistence(); unsubscribeStorage(); };
    }, [binding]);

    React.useEffect(() => {
        if (!binding?.isCurrent()) return;
        const abort = new AbortController();
        const retirement = binding.onRetire(() => abort.abort());
        const accountId = binding.accountId;
        setState(current => ({ scopeKey, accountId, settings: current.accountId === accountId ? current.settings : null, loading: true, error: null }));
        void (async () => {
            const account = await captureLazyActionAccountContext(binding.serverId, abort.signal);
            try {
                if (account.accountId !== binding.accountId) throw new Error('action_account_scope_changed');
                const settings = await account.readSettings();
                account.assertCurrent();
                if (!abort.signal.aborted && binding.isCurrent()) setState({ scopeKey, accountId, loading: false, error: null,
                    settings: { managedMachineCreationEnabled: settings.managedMachineCreationEnabled,
                        machineRetentionDefaultsV1: settings.machineRetentionDefaultsV1 } });
            } finally { account.dispose(); }
        })().catch(() => {
            if (!abort.signal.aborted && binding.isCurrent()) setState({ scopeKey, accountId, settings: null, loading: false, error: 'managed_settings_unavailable' });
        });
        return () => { abort.abort(); retirement.dispose(); };
    }, [binding, scopeKey, revision]);

    if (!binding?.isCurrent()) {
        return resolution.kind === 'bound' && state.accountId === resolution.scope.accountId
            ? { settings: state.settings, loading: true, error: null } : NO_SETTINGS;
    }
    return state.scopeKey === scopeKey ? state
        : { settings: state.accountId === binding.accountId ? state.settings : null, loading: true, error: null };
}
