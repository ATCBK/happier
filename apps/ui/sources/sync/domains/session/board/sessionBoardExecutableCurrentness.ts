import type { SessionBoardItemProjection, SessionBoardSnapshot } from './sessionBoardProjection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { sessionBoardSourceRequiresExclusiveMount } from './sessionBoardPrimaryMount';

/**
 * The exact currentness proof an executable Session item may consume.
 *
 * Last-known Board bytes alone are not authority to keep a frame, plugin Host
 * API, or Resource watch alive. An unchanged configured widget can keep its
 * admitted Resource lifetime during a reread while the canonical Session
 * capabilities and exact plugin runtime remain current. A stale settled read
 * or offline authority still pauses execution. An
 * installed surface additionally needs the current interactive plugin
 * projection that supplies its code and authority. This projection deliberately
 * ignores `incomplete`: a current exact item need not stop merely because a later
 * inventory page is still loading.
 */
export type SessionBoardExecutableCurrentness =
    | 'current'
    | 'stale'
    | 'offline'
    | 'unverified'
    | 'not_executable';

export function resolveSessionBoardExecutableCurrentness(
    snapshot: Pick<SessionBoardSnapshot, 'capabilities' | 'reachability' | 'freshness' | 'loading' | 'itemsById'>,
    item: SessionBoardItemProjection,
    pluginRuntime?: Pick<
        PluginUiProjectionCurrentness,
        'pluginUiProjection' | 'phase' | 'interactionEnabled'
    > | null,
): SessionBoardExecutableCurrentness {
    if (item.state.kind !== 'ready' || !sessionBoardSourceRequiresExclusiveMount(item.state.item.source.kind)) {
        return 'not_executable';
    }
    if (!snapshot.capabilities.readTranscript) return 'unverified';
    if (snapshot.reachability === 'offline') return 'offline';
    if (snapshot.reachability !== 'reachable') return 'unverified';
    const current = snapshot.itemsById.get(item.itemId);
    if (!current || current.revision === null || current.revision !== item.revision
        || current.state.kind !== 'ready') {
        return 'unverified';
    }
    // Record invalidation is a content reread, not a withdrawal of the current
    // Session/plugin authority. Unmounting an unchanged widget here discards
    // its Resource's last-good content and repeats its initial read on every
    // Board write. Keep that lifetime only during the actual reread; the checks
    // above and below still reject revoked access, a replaced record or plugin.
    if (snapshot.freshness !== 'fresh'
        && !(snapshot.loading === 'refreshing' && item.state.item.source.kind === 'widget')) return 'stale';
    if (item.state.item.source.kind === 'widget' && item.state.item.source.instance.definition.kind === 'installed') {
        if (!pluginRuntime || pluginRuntime.phase === 'unavailable') return 'unverified';
        if (pluginRuntime.phase === 'retainedOffline') return 'offline';
        if (pluginRuntime.phase === 'establishing') return 'stale';
        if (!pluginRuntime.pluginUiProjection || !pluginRuntime.interactionEnabled) return 'unverified';
    }
    return 'current';
}
