import * as React from 'react';

import type { PeerMediationObservabilityScopeV1 } from '@happier-dev/protocol';

import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { useProfile } from '@/sync/store/hooks';
import {
    useSessionAddressForSessionId,
    useSessionPluginRuntime,
    type SessionPaneSurfaceScope,
    type SessionPluginRuntimeState,
} from '@/components/sessions/plugins/useSessionPluginRuntime';

export type SessionDetailsPanelPluginRuntimeState = SessionPluginRuntimeState & Readonly<{
    peerMediationObservabilityScope: PeerMediationObservabilityScopeV1 | null;
}>;

function readProfileId(profile: unknown): string | null {
    if (!profile || typeof profile !== 'object') {
        return null;
    }
    const id = (profile as { id?: unknown }).id;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

export function useSessionDetailsPanelPluginRuntime(params: Readonly<{
    sessionId: string;
    routeServerId?: string | null;
    /**
     * AppPane's registered driver is the authority for target/projection facts.
     * Direct screen renders omit this and retain their incumbent local lookup.
     */
    paneSurfaceScope?: SessionPaneSurfaceScope;
    pluginUiProjection?: PluginUiProjectionModel | null;
    peerMediationObservabilityScope?: PeerMediationObservabilityScopeV1 | null;
    platform?: LocalServicePreviewPlatform;
}>): SessionDetailsPanelPluginRuntimeState {
    // Qualify the Home-local Session id once, at this entry boundary, through
    // the canonical Session server owner.
    const address = useSessionAddressForSessionId(
        params.sessionId,
        params.paneSurfaceScope?.serverId ?? params.routeServerId,
    );
    const pluginRuntime = useSessionPluginRuntime({
        address,
        paneSurfaceScope: params.paneSurfaceScope,
        pluginUiProjection: params.pluginUiProjection,
        platform: params.platform,
    });
    const profileId = useProfile(readProfileId);
    const derivedObservabilityScope = React.useMemo<PeerMediationObservabilityScopeV1 | null>(() => {
        if (!pluginRuntime.machineId || !profileId) {
            return null;
        }
        return {
            kind: 'machine',
            accountId: profileId,
            machineId: pluginRuntime.machineId,
        };
    }, [pluginRuntime.machineId, profileId]);

    return React.useMemo(() => ({
        ...pluginRuntime,
        peerMediationObservabilityScope:
            params.peerMediationObservabilityScope !== undefined
                ? params.peerMediationObservabilityScope
                : derivedObservabilityScope,
    }), [
        derivedObservabilityScope,
        params.peerMediationObservabilityScope,
        pluginRuntime,
    ]);
}
