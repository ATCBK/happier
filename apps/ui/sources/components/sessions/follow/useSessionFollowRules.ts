import * as React from 'react';

import { readSessionFollowRuleInputs, type SessionFollowRulesReadResult } from '@/sync/api/session/sessionFollowRulesApi';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isAccountFollowConfigurationChangeRelevant } from './sessionFollowAccountChange';

/** A mounted screen's private input, shared by its rule rows and previews. Not retained between screens. */
export function useSessionFollowRules(serverId: string | null, enabled: boolean) {
    const activeScope = useActiveServerAccountScope();
    const currentScope = enabled ? selectActiveServerAccountScopeForServer(activeScope, serverId) : null;
    const { binding, resolution } = useServerCredentialAccountScopeBinding(enabled && !currentScope ? serverId : null);
    const lifetime = currentScope ? captureActiveServerAccountScopeLifetime() : binding;
    const accountId = currentScope?.accountId ?? binding?.accountId;
    const [state, setState] = React.useState<Readonly<{
        lifetime: typeof lifetime; snapshot: SessionFollowRulesReadResult;
    }> | null>(null);
    const refreshRef = React.useRef<() => Promise<void>>(() => Promise.resolve());
    const refresh = React.useCallback(() => refreshRef.current(), []);
    React.useEffect(() => {
        if (!enabled || !serverId || !accountId || !lifetime?.isCurrent()) return;
        const controller = new AbortController();
        const isCurrent = () => !controller.signal.aborted && lifetime.isCurrent();
        let running: Promise<void> | null = null;
        let dirty = false;
        const read = (): Promise<void> => {
            if (!isCurrent()) return Promise.resolve();
            if (running) { dirty = true; return running; }
            running = (async () => {
                try {
                    do {
                        dirty = false;
                        const snapshot = await readSessionFollowRuleInputs(serverId, controller.signal, { expectedAccountId: accountId });
                        if (!isCurrent()) return;
                        setState({ lifetime, snapshot });
                    } while (dirty && isCurrent());
                } finally { running = null; }
            })();
            return running;
        };
        refreshRef.current = read;
        const retirement = lifetime.onRetire(() => { controller.abort(); setState(null); });
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (isCurrent() && areServerProfileIdentifiersEquivalent(event.serverId, serverId)
                && isAccountFollowConfigurationChangeRelevant(event)) void read();
        });
        void read();
        return () => { controller.abort(); retirement.dispose(); unsubscribe(); refreshRef.current = () => Promise.resolve(); };
    }, [enabled, serverId, accountId, lifetime]);
    const snapshot = enabled && lifetime?.isCurrent() && state?.lifetime === lifetime ? state.snapshot : null;
    return { snapshot, lifetime, accountId, refresh,
        loading: enabled && Boolean(serverId) && (resolution.kind === 'resolving' || Boolean(lifetime?.isCurrent() && !snapshot)) };
}

export type SessionFollowRulesController = ReturnType<typeof useSessionFollowRules>;
