import * as React from 'react';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { sessionFollowGet, sessionFollowRemove, sessionFollowSet } from '@/sync/api/session/sessionFollowApi';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isServerReachabilityNetworkAllowed, subscribeServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { createAccountSessionFollowController, projectAccountSessionFollowPolicyEditor } from './accountSessionFollowController';

/** Every personal Follow host shares this captured Account/Home lifetime. */
export function useAccountSessionFollowController(address: SessionAddress, enabled: boolean, onRetire?: () => void) {
    const { serverId, sessionId } = address;
    const controller = React.useMemo(() => createAccountSessionFollowController({ serverId, sessionId }, {
        get: sessionFollowGet, set: sessionFollowSet, remove: sessionFollowRemove,
    }), [serverId, sessionId]);
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const onRetireRef = React.useRef(onRetire);
    onRetireRef.current = onRetire;
    React.useEffect(() => {
        if (!enabled) return;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime?.isCurrent()) return;
        const retire = () => { controller.dispose(); onRetireRef.current?.(); };
        const retirement = lifetime.onRetire(retire);
        const credentials = subscribeHomeCredentialMutations(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) retire();
        });
        controller.setOnline(isServerReachabilityNetworkAllowed());
        const connectivity = subscribeServerReachabilityNetworkAllowed(online => {
            const wasOffline = !controller.getSnapshot().online;
            controller.setOnline(online);
            if (online && wasOffline) void controller.refresh();
        });
        const changes = subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) void controller.refresh();
        });
        void controller.refresh();
        return () => { retirement.dispose(); credentials(); connectivity(); changes(); };
    }, [controller, enabled, serverId]);
    const policyEditor = React.useMemo(() => projectAccountSessionFollowPolicyEditor(state), [state]);
    return { controller, state, policyEditor };
}
