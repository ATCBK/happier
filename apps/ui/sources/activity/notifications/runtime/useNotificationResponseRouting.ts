import { router } from 'expo-router';
import * as React from 'react';
import { AppState, Platform } from 'react-native';

import { normalizeServerUrl, setActiveServerAndSwitch, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerUrl, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } from '@/sync/domains/pending/pendingNotificationNav';
import {
    clearPendingNotificationAction,
    getPendingNotificationAction,
} from '@/sync/domains/pending/pendingNotificationAction';
import { EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS, loadExpoNotifications, type ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import { withTimeout } from '@/utils/timing/time';
import { navigateToSessionRoute } from '@/hooks/session/navigateToSessionRoute';
import { executeNotificationPermissionAction } from './notificationPermissionActions';
import { markNotificationResponseHandled, wasNotificationResponseHandled } from './notificationResponseConsumption';
import { consumeNotificationPermissionRecoveryNeeded, markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';

import { isNotificationPermissionAction, isUnsafeNotificationServerUrl, parseNotificationTap } from '../notificationRouting';

type ExpoNotificationsWithClear = ExpoNotificationsModule & Readonly<{
    clearLastNotificationResponseAsync?: () => Promise<void>;
}>;

function findSavedServerProfileForUrl(serverUrl: string): { id: string; serverUrl: string } | null {
    const targetKey = createServerUrlComparableKey(serverUrl);
    if (!targetKey) return null;
    for (const profile of listServerProfiles()) {
        if (createServerUrlComparableKey(profile.serverUrl) === targetKey) {
            return { id: profile.id, serverUrl: profile.serverUrl };
        }
    }
    return null;
}

export function useNotificationResponseRouting(params: Readonly<{
    enabled: boolean;
    refreshAuth: () => Promise<void>;
}>): void {
    const refreshAuthRef = React.useRef(params.refreshAuth);
    const handledNavigationResponsesRef = React.useRef(new Set<string>());

    React.useEffect(() => {
        refreshAuthRef.current = params.refreshAuth;
    }, [params.refreshAuth]);

    React.useEffect(() => {
        if (!params.enabled) {
            return;
        }

        if (Platform.OS === 'web') return;

        let disposed = false;
        const showRecoveryIfActive = async () => {
            if (disposed || Platform.OS !== 'android' || AppState.currentState !== 'active') return;
            try {
                const [{ Modal }, { t }] = await withTimeout(
                    () => Promise.all([import('@/modal'), import('@/text')]),
                    EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS,
                    'notification recovery UI module load',
                );
                if (!disposed && AppState.currentState === 'active' && consumeNotificationPermissionRecoveryNeeded()) {
                    Modal.alert(t('common.error'), t('notifications.permissionActionNeedsReview'));
                }
            } catch {
                console.warn('[notifications] Permission action recovery unavailable');
            }
        };

        const pendingAction = getPendingNotificationAction();
        if (pendingAction && Platform.OS === 'android') {
            // Old versions queued actions across server switches. Do not replay an
            // old decision when adopting background actions: require in-app review.
            clearPendingNotificationAction();
            try {
                markNotificationPermissionRecoveryNeeded();
            } catch {
                console.warn('[notifications] Permission action recovery storage unavailable');
            }
            console.warn('[notifications] Saved permission action requires in-app review');
        }
        if (pendingAction && Platform.OS !== 'android') {
            const active = normalizeServerUrl(getActiveServerUrl());
            if (normalizeServerUrl(pendingAction.serverUrl) === active) {
                clearPendingNotificationAction();
                // Legacy pending records have no occurrence identity and are review-only.
                const saved = findSavedServerProfileForUrl(pendingAction.serverUrl);
                fireAndForget((async () => {
                    navigateToSessionRoute({ router, sessionId: pendingAction.sessionId, serverId: saved?.id, refreshAuth: refreshAuthRef.current });
                })(), { tag: 'RootLayout.pendingNotificationAction' });
                return;
            }
        }

        const pending = getPendingNotificationNav();
        if (pending) {
            const active = normalizeServerUrl(getActiveServerUrl());
            if (normalizeServerUrl(pending.serverUrl) === active) {
                clearPendingNotificationNav();
                router.push(pending.route);
                return;
            }
        }

        const maybeRedirectFromResponse = (response: unknown, defaultActionIdentifier: string, allowExecution = true) => {
            let parsed = parseNotificationTap({
                response,
                defaultActionIdentifier,
            });
            if (!parsed) return;

            // Registration controls native foregrounding, not callback ownership.
            // The task does not receive every foreground press. Both paths must
            // invoke the same guarded executor before navigation/server switching.
            if (Platform.OS === 'android' && isNotificationPermissionAction(parsed)) {
                if (allowExecution) {
                    fireAndForget(executeNotificationPermissionAction(parsed).then(showRecoveryIfActive), { tag: 'notificationPermissionAction' });
                    return;
                }
                // Expo also caches actions handled without opening an Activity.
                // Only an unhandled saved launch needs foreground review.
                if (wasNotificationResponseHandled(parsed)) return;
                parsed = { ...parsed, permissionAction: null, isOpenAction: true };
            }

            if (isNotificationPermissionAction(parsed)) {
                if (wasNotificationResponseHandled(parsed)) return;
                markNotificationResponseHandled(parsed);
            } else if (parsed.dedupeKey) {
                if (handledNavigationResponsesRef.current.has(parsed.dedupeKey)) return;
                handledNavigationResponsesRef.current.add(parsed.dedupeKey);
            }

            if (!parsed.route) return;

            const route = parsed.route;
            const routeSessionId = parsed.routeSessionId;
            const serverUrl = parsed.serverUrl;
            const savedTarget = serverUrl ? findSavedServerProfileForUrl(serverUrl) : null;
            const navigateToRoute = (serverId?: string) => {
                if (routeSessionId) {
                    navigateToSessionRoute({ router, sessionId: routeSessionId, serverId, refreshAuth: refreshAuthRef.current });
                } else {
                    router.push(route);
                }
            };
            const routeToServerSettingsForUrl = (url: string) => {
                router.push(`/settings/server?url=${encodeURIComponent(url)}&source=notification`);
            };

            if (routeSessionId && (!serverUrl || savedTarget)) {
                if (parsed.permissionAction && serverUrl) {
                    fireAndForget((async () => {
                        try {
                            await executeNotificationPermissionAction(parsed);
                        } catch {
                            // Navigation still opens the request for in-app review.
                        }
                        navigateToRoute(savedTarget?.id);
                    })(), { tag: 'RootLayout.notificationAction.session' });
                } else {
                    navigateToRoute(savedTarget?.id);
                }
                return;
            }

            // Permission action buttons are security-sensitive. Only perform allow/deny when:
            // - the server is already active, OR
            // - the server is already saved (we can switch safely), OR
            // - (otherwise) navigate only and let the user handle it in-app.
            if (parsed.permissionAction) {
                if (!serverUrl) {
                    router.push(route);
                    return;
                }

                const active = normalizeServerUrl(getActiveServerUrl());
                if (serverUrl !== active) {
                    const saved = findSavedServerProfileForUrl(serverUrl);
                    if (!saved) {
                        if (isUnsafeNotificationServerUrl(serverUrl)) {
                            router.push(route);
                            return;
                        }
                        // If the app has no servers, we can auto-add/switch to restore a working deep link,
                        // but never perform the allow/deny action on an unsaved server.
                        if (listServerProfiles().length === 0) {
                            setPendingNotificationNav({ serverUrl, route });
                            fireAndForget((async () => {
                                try {
                                    await upsertActivateAndSwitchServer({
                                        serverUrl,
                                        source: 'notification',
                                        scope: 'device',
                                        refreshAuth: refreshAuthRef.current,
                                    });
                                    clearPendingNotificationNav();
                                    navigateToRoute(findSavedServerProfileForUrl(serverUrl)?.id);
                                } catch {
                                    // keep pending notification nav as fallback
                                }
                            })(), { tag: 'RootLayout.notificationNav.autoAddServer.actionTap' });
                            return;
                        }
                        // Servers exist but the target isn't saved: redirect to server settings with a prefilled url.
                        setPendingNotificationNav({ serverUrl, route });
                        routeToServerSettingsForUrl(serverUrl);
                        return;
                    }

                    // Persist navigation recovery, never an approval to replay
                    // after a later authentication or server-switch lifecycle.
                    setPendingNotificationNav({ serverUrl: saved.serverUrl, route });
                    fireAndForget((async () => {
                        try {
                            await setActiveServerAndSwitch({
                                serverId: saved.id,
                                scope: 'device',
                                refreshAuth: refreshAuthRef.current,
                            });
                            clearPendingNotificationNav();
                            try {
                                await executeNotificationPermissionAction(parsed);
                            } catch {
                                // best-effort
                            }
                            navigateToRoute(saved.id);
                        } catch {
                            // Keep navigation for in-app review after recovery.
                        }
                    })(), { tag: 'RootLayout.notificationAction.savedServer' });
                    return;
                }
            }

            if (serverUrl) {
                const active = normalizeServerUrl(getActiveServerUrl());
                if (serverUrl !== active) {
                    const saved = findSavedServerProfileForUrl(serverUrl);
                    if (saved) {
                        setPendingNotificationNav({ serverUrl: saved.serverUrl, route });
                        fireAndForget((async () => {
                            try {
                                await setActiveServerAndSwitch({
                                    serverId: saved.id,
                                    scope: 'device',
                                    refreshAuth: refreshAuthRef.current,
                                });
                                clearPendingNotificationNav();
                                navigateToRoute(saved.id);
                            } catch {
                                // keep pending notification nav as fallback
                            }
                        })(), { tag: 'RootLayout.notificationNav.savedServer' });
                        return;
                    }

                    if (isUnsafeNotificationServerUrl(serverUrl)) {
                        // Unsafe/mismatched server url: fail closed for actions; navigate only.
                        router.push(route);
                        return;
                    }

                    if (listServerProfiles().length === 0) {
                        setPendingNotificationNav({ serverUrl, route });
                        fireAndForget((async () => {
                            try {
                                await upsertActivateAndSwitchServer({
                                    serverUrl,
                                    source: 'notification',
                                    scope: 'device',
                                    refreshAuth: refreshAuthRef.current,
                                });
                                clearPendingNotificationNav();
                                navigateToRoute(findSavedServerProfileForUrl(serverUrl)?.id);
                            } catch {
                                // keep pending notification nav as fallback
                            }
                        })(), { tag: 'RootLayout.notificationNav.autoAddServer' });
                        return;
                    }
                    // Servers exist but the target isn't saved: redirect to server settings with a prefilled url.
                    setPendingNotificationNav({ serverUrl, route });
                    routeToServerSettingsForUrl(serverUrl);
                    return;
                }
            }

            if (parsed.permissionAction) {
                fireAndForget((async () => {
                    try {
                        await executeNotificationPermissionAction(parsed);
                    } catch {
                        // best-effort
                    }
                    navigateToRoute(savedTarget?.id);
                })(), { tag: 'RootLayout.notificationAction.activeServer' });
                return;
            }

            if (parsed.isOpenAction) {
                router.push(route);
            }
        };

        const recoverySubscription = Platform.OS === 'android'
            ? AppState.addEventListener('change', (state) => { if (state === 'active') void showRecoveryIfActive(); })
            : null;
        void showRecoveryIfActive();
        let subscription: { remove: () => void } | null = null;
        void loadExpoNotifications()
            .then((Notifications) => {
                if (disposed) return;
                const defaultActionIdentifier = Notifications.DEFAULT_ACTION_IDENTIFIER;
                void Notifications.getLastNotificationResponseAsync()
                    .then(async (response) => {
                        if (disposed || !response) return;
                        maybeRedirectFromResponse(response, defaultActionIdentifier, false);
                        const clearLastNotificationResponseAsync = (Notifications as ExpoNotificationsWithClear).clearLastNotificationResponseAsync;
                        if (typeof clearLastNotificationResponseAsync === 'function') {
                            await clearLastNotificationResponseAsync();
                        }
                    })
                    .catch(() => {});

                subscription = Notifications.addNotificationResponseReceivedListener((response) => {
                    maybeRedirectFromResponse(response, defaultActionIdentifier);
                });
            })
            .catch(() => {});

        return () => {
            disposed = true;
            subscription?.remove();
            recoverySubscription?.remove();
        };
    }, [params.enabled]);
}
