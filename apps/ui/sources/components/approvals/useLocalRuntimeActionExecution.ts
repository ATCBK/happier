import * as React from 'react';
import { useMountedActionExecution } from './useMountedActionExecution';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

/** Local runtime ownership does not require a Personal Home profile receipt.
 * Signed-in device controls use the active Account's ordinary Action policy.
 * Only confirmed sign-out or an actually unpersisted draft bypasses admission.
 */
export function useLocalRuntimeActionExecution(scope?: ServerAccountScope,
    options?: Parameters<typeof useMountedActionExecution>[1]) {
    const activeHome = useActiveServerSnapshot(!scope);
    const mounted = useMountedActionExecution(scope ?? activeHome.serverId, options);
    const signedOutDraft = !scope && (mounted.resolution.kind === 'signed_out'
        || (mounted.resolution.kind === 'unknown_home' && !getServerProfileById(activeHome.serverId)));
    const runSignedOutDraft = React.useCallback(async <T,>(effect: () => Promise<T>): Promise<T> => {
        const capturedHomeIsCurrent = () => {
            const current = getActiveServerSnapshot();
            return current.serverId === activeHome.serverId && current.serverUrl === activeHome.serverUrl;
        };
        if (!signedOutDraft || !capturedHomeIsCurrent()) throw new Error('action_account_scope_changed');
        // A picker/confirmation can hold an old signed-out callback across sign-in.
        // Re-read the canonical credential owner at the raw effect point; never
        // silently lend that old draft the new Account's authority.
        const current = await resolveServerCredentialAccountScope(activeHome.serverId);
        if (!capturedHomeIsCurrent() || !(current.kind === 'signed_out'
            || (current.kind === 'unknown_home' && !getServerProfileById(activeHome.serverId)))) {
            throw new Error('action_account_scope_changed');
        }
        return await effect();
    }, [activeHome.serverId, activeHome.serverUrl, signedOutDraft]);
    return { ...mounted, requiresAction: !signedOutDraft, ready: mounted.ready || signedOutDraft, runSignedOutDraft };
}
