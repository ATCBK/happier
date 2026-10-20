import * as React from 'react';

import type { Settings } from '@/sync/domains/settings/settings';
import {
    loadEffectiveHomeViewState,
    subscribeEffectiveHomeViewState,
    updateEffectiveHomeViewState,
} from '@/sync/domains/server/selection/homeViewSelectionState';
import { normalizeServerSelectionGroupsForSettings } from '@/sync/domains/server/selection/serverSelectionSettingsAdapter';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { getStorage } from '@/sync/domains/state/storageStore';

export type HomeViewSelectionSettings = Pick<
    Settings,
    'serverSelectionGroups' | 'serverSelectionActiveTargetKind' | 'serverSelectionActiveTargetId'
>;

/**
 * Until the one-time migration writes the device-global Home-view state, the
 * three legacy Account-scoped keys remain the fallback. They are subscribed key
 * by key rather than through the whole `Settings` object: persistent surfaces
 * (header/sidebar connection control, session lists, new-session targeting)
 * hold this hook for the life of the session and must not rerender for every
 * unrelated Account setting.
 */
function useLegacyHomeViewSelectionSettings(): HomeViewSelectionSettings {
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const serverSelectionActiveTargetKind = useSetting('serverSelectionActiveTargetKind');
    const serverSelectionActiveTargetId = useSetting('serverSelectionActiveTargetId');
    return React.useMemo(() => ({
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
    }), [serverSelectionActiveTargetId, serverSelectionActiveTargetKind, serverSelectionGroups]);
}

export function useHomeViewSelectionSettings(): HomeViewSelectionSettings {
    const state = React.useSyncExternalStore(
        subscribeEffectiveHomeViewState,
        loadEffectiveHomeViewState,
        loadEffectiveHomeViewState,
    );
    const legacySettings = useLegacyHomeViewSelectionSettings();
    return React.useMemo(() => state
        ? {
            serverSelectionGroups: normalizeServerSelectionGroupsForSettings(state.groups),
            serverSelectionActiveTargetKind: state.activeTargetKind,
            serverSelectionActiveTargetId: state.activeTargetId,
        }
        : legacySettings, [legacySettings, state]);
}

export function useHomeViewSelectionSettingsMutable(): HomeViewSelectionSettings & Readonly<{
    setHomeViewSelectionSettings: (
        update: HomeViewSelectionSettings | ((current: HomeViewSelectionSettings) => HomeViewSelectionSettings),
        options?: Readonly<{ targetScope?: 'tab' | 'device' }>,
    ) => Promise<void>;
}> {
    const settings = useHomeViewSelectionSettings();
    const setHomeViewSelectionSettings = React.useCallback(async (
        update: HomeViewSelectionSettings | ((current: HomeViewSelectionSettings) => HomeViewSelectionSettings),
        options?: Readonly<{ targetScope?: 'tab' | 'device' }>,
    ) => {
        const saved = await updateEffectiveHomeViewState((current) => {
            const currentSettings: HomeViewSelectionSettings = {
                serverSelectionGroups: normalizeServerSelectionGroupsForSettings(current.groups),
                serverSelectionActiveTargetKind: current.activeTargetKind,
                serverSelectionActiveTargetId: current.activeTargetId,
            };
            const requested = typeof update === 'function' ? update(currentSettings) : update;
            return {
                version: 1,
                groups: requested.serverSelectionGroups,
                activeTargetKind: requested.serverSelectionActiveTargetKind,
                activeTargetId: requested.serverSelectionActiveTargetId,
            };
        }, { scope: options?.targetScope ?? 'device' });
        const projected: HomeViewSelectionSettings = {
            serverSelectionGroups: normalizeServerSelectionGroupsForSettings(saved.groups),
            serverSelectionActiveTargetKind: saved.activeTargetKind,
            serverSelectionActiveTargetId: saved.activeTargetId,
        };
        // Compatibility projection for existing Settings readers only. The Account-scoped
        // settings transport must never become a writer for device-global Home selection.
        getStorage().getState().applySettingsLocal(projected);
    }, []);
    return React.useMemo(() => ({
        ...settings,
        setHomeViewSelectionSettings,
    }), [settings, setHomeViewSelectionSettings]);
}
