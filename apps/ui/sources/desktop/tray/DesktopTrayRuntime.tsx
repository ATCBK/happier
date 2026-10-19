import * as React from 'react';

import { useRouter } from 'expo-router';

import { useAuth } from '@/auth/context/AuthContext';
import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import {
    readLocalDaemonSharedState,
    subscribeLocalDaemonSharedState,
} from '@/components/settings/machines/localControl/localDaemonSharedState';
import { refreshLocalDaemonStatus, type LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useAppAccountIdentity } from '@/components/settings/machines/localControl/useThisComputerConnection';
import { resolveHomeDisplayNameForRelayUrl } from '@/components/settings/server/homeDisplayName';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';
import { getDefaultSystemTaskRunner } from '@/components/systemTasks';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { describeUpdatesTrayItem } from '@/components/updates/describeUpdatesSummary';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readAppHomeSessionCount } from '@/desktop/thisComputer/thisComputerSessionVisibility';
import { projectThisComputerServiceRowsForApp } from '@/sync/domains/server/relayDrift/thisComputerConnection';
import { storage } from '@/sync/domains/state/storageStore';
import { useSharedUpdatesSummary } from '@/updates/useUpdatesSummary';
import { t } from '@/text';
import { isDesktopHost, listenDesktopHostEvent } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { applyTauriTrayState, readDesktopTrayDestination, type DesktopTrayDestination } from './applyTauriTrayState';
import { buildDesktopTrayMenuState } from './buildDesktopTrayMenuState';
import { buildDesktopTrayState } from './buildDesktopTrayState';
import { openHomeFromTrayRow } from './trayHome';

/** Emitted by the native side after a tray action or the login-start item changed the services. */
export const DESKTOP_BACKGROUND_SERVICES_CHANGED_EVENT = 'desktop_background_services_changed';

/**
 * Emitted by the native side when the tray menu is about to be shown while this window exists
 * (N-12, A12-03): the native side owns the one throttle, so every demand that arrives re-reads.
 */
export const DESKTOP_TRAY_REFRESH_REQUESTED_EVENT = 'desktop_tray_refresh_requested';

/** Emitted by the native side when a row's Open is chosen while the window exists (D11-3). */
export const DESKTOP_OPEN_HOME_REQUESTED_EVENT = 'desktop_open_home_requested';

export const DESKTOP_OPEN_SETTINGS_REQUESTED_EVENT = 'desktop_open_settings_requested';
export const DESKTOP_OPEN_UPDATES_REQUESTED_EVENT = 'desktop_open_updates_requested';

const SCREEN_ROUTES = {
    updates: UPDATES_ROUTE,
    settings: SETTINGS_ROUTES.general,
} as const satisfies Record<'updates' | 'settings', string>;

function useDesktopHostEvent(event: string, onEvent: (payload: unknown) => void): void {
    React.useEffect(() => {
        let disposed = false;
        let unlisten: (() => void) | null = null;
        void listenDesktopHostEvent<unknown>(event, onEvent).then((stop) => {
            if (disposed) stop();
            else unlisten = stop;
        }).catch(() => {});
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [event, onEvent]);
}

function TauriDesktopTrayRuntime(): React.ReactElement | null {
    const connectionHealth = useConnectionHealth();
    const relayDriftBanner = useRelayDriftBanner();
    // The tray's one Updates item ("Updates available (N)…"), from the shared summary; the tray
    // opens Settings › Updates itself.
    const updatesItem = describeUpdatesTrayItem(useSharedUpdatesSummary());
    const updatesLabel = updatesItem?.label ?? null;
    const updatesEnabled = updatesItem?.enabled ?? true;
    const router = useRouter();
    const activeServer = useActiveServerSnapshot();
    const { accountId } = useAppAccountIdentity();
    const auth = useAuth();
    // Read at the moment a row is opened; the tray never re-subscribes when auth changes.
    const refreshAuthRef = React.useRef(auth.refreshFromActiveServer);
    refreshAuthRef.current = auth.refreshFromActiveServer;
    const openDestination = React.useCallback((destination: DesktopTrayDestination) => {
        if (typeof destination === 'string') {
            router.push(SCREEN_ROUTES[destination]);
            return;
        }
        fireAndForget(openHomeFromTrayRow(destination.relayUrl, () => refreshAuthRef.current()).then((outcome) => {
            // Two saved Homes share that address: show every Home this computer serves to pick from.
            if (outcome === 'ambiguous') router.push(SETTINGS_ROUTES.machinesThisComputer);
        }), {
            tag: 'DesktopTrayRuntime.openHomeFromTrayRow',
        });
    }, [router]);

    // This computer's last status, shared by every surface that describes it (the relay drift
    // banner above already reads it on mount); the tray starts no read of its own.
    const runner = React.useMemo(() => getDefaultSystemTaskRunner(), []);
    const subscribe = React.useCallback((listener: () => void) => subscribeLocalDaemonSharedState(runner, listener), [runner]);
    const readStatus = React.useCallback(() => readLocalDaemonSharedState<LocalDaemonStatusData>(runner).status, [runner]);
    const status = React.useSyncExternalStore(subscribe, readStatus, readStatus);
    // A13-07: running sessions for the app's Home, only when the app can see them (one owner with Quit).
    const appHomeSessionCount = storage((state) => readAppHomeSessionCount({
        status,
        isDataReady: state.isDataReady,
        appAccountId: accountId,
        activeRelayUrl: activeServer.serverUrl,
        activeLocalRelayUrl: activeServer.activeLocalRelayUrl ?? null,
        sessions: state.sessions,
    }));
    // The status task's params from the one spec builder (scoped to the app's Home); the native
    // side replays them in menu-bar mode.
    const taskParams = React.useMemo(
        () => buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1').params as Record<string, unknown>,
        [activeServer.serverUrl],
    );

    const trayState = React.useMemo(() => ({
        ...buildDesktopTrayState({
            health: {
                kind: connectionHealth.kind,
                machineCount: connectionHealth.machineCount,
                onlineCount: connectionHealth.onlineCount,
                statusLabelKey: connectionHealth.statusLabelKey,
                machineLabelKey: connectionHealth.machineLabelKey,
            },
            relayDriftBannerTitle: relayDriftBanner?.title ?? null,
            updates: updatesLabel ? { label: updatesLabel, enabled: updatesEnabled } : null,
            t,
        }),
        ...buildDesktopTrayMenuState({
            services: projectThisComputerServiceRowsForApp({
                status,
                activeRelayUrl: activeServer.serverUrl,
                activeLocalRelayUrl: activeServer.activeLocalRelayUrl ?? null,
                appAccountId: accountId,
                appHomeActiveSessionCount: appHomeSessionCount,
            }),
            // The tray's "Start at login" is the one setting: every managed service's common mode (A13-02).
            serviceAutostart: status?.serviceAutostart ?? null,
            // Forwarded unchanged: a positive count proves a managed service runs even where rows hide it.
            runningManagedServiceCount: status?.runningManagedServiceCount ?? null,
            taskParams,
            homeNameFor: resolveHomeDisplayNameForRelayUrl,
            t,
        }),
    }), [
        accountId,
        activeServer.activeLocalRelayUrl,
        activeServer.serverUrl,
        appHomeSessionCount,
        connectionHealth.kind,
        connectionHealth.machineCount,
        connectionHealth.machineLabelKey,
        connectionHealth.onlineCount,
        connectionHealth.statusLabelKey,
        relayDriftBanner?.title,
        status,
        taskParams,
        updatesEnabled,
        updatesLabel,
    ]);

    React.useEffect(() => {
        fireAndForget(applyTauriTrayState(trayState).then((destination) => {
            // A tray item that rebuilt this window (menu-bar mode) asked for this.
            if (destination) openDestination(destination);
        }), {
            tag: 'DesktopTrayRuntime.applyTauriTrayState',
        });
    }, [openDestination, trayState]);

    // A native Start / Restart / Stop, or the login-start item, changed the services: every
    // surface describing this computer re-reads. A row's Open with the window up picks its Home.
    const refreshThisComputer = React.useCallback(() => {
        fireAndForget(refreshLocalDaemonStatus(runner), { tag: 'DesktopTrayRuntime.refreshLocalDaemonStatus' });
    }, [runner]);
    useDesktopHostEvent(DESKTOP_BACKGROUND_SERVICES_CHANGED_EVENT, refreshThisComputer);
    // The menu is about to open: its rows should be current (N-12).
    useDesktopHostEvent(DESKTOP_TRAY_REFRESH_REQUESTED_EVENT, refreshThisComputer);
    useDesktopHostEvent(DESKTOP_OPEN_SETTINGS_REQUESTED_EVENT, React.useCallback(() => {
        openDestination('settings');
    }, [openDestination]));
    useDesktopHostEvent(DESKTOP_OPEN_UPDATES_REQUESTED_EVENT, React.useCallback(() => {
        openDestination('updates');
    }, [openDestination]));
    useDesktopHostEvent(DESKTOP_OPEN_HOME_REQUESTED_EVENT, React.useCallback((payload: unknown) => {
        const destination = readDesktopTrayDestination(payload);
        if (destination && typeof destination !== 'string') openDestination(destination);
    }, [openDestination]));

    return null;
}

export function DesktopTrayRuntime(): React.ReactElement | null {
    if (!isDesktopHost()) return null;
    return <TauriDesktopTrayRuntime />;
}
