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
    setPendingNotificationAction,
} from '@/sync/domains/pending/pendingNotificationAction';
import { EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS, loadExpoNotifications, type ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import { withTimeout } from '@/utils/timing/time';
import { navigateToSessionRoute } from '@/hooks/session/navigateToSessionRoute';
import { executeNotificationPermissionAction, isNotificationPermissionAction } from './notificationPermissionActions';

import { isUnsafeNotificationServerUrl, parseNotificationTap } from '../notificationRouting';

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
    const handledNotificationResponseKeysRef = React.useRef<Set<string>>(new Set());
    const refreshAuthRef = React.useRef(params.refreshAuth);

    React.useEffect(() => {
        refreshAuthRef.current = params.refreshAuth;
    }, [params.refreshAuth]);

    React.useEffect(() => {
        if (!params.enabled) {
            handledNotificationResponseKeysRef.current.clear();
            return;
        }

        if (Platform.OS === 'web') return;

        let disposed = false;
        const showRecoveryIfActive = async () => {
            if (disposed || Platform.OS !== 'android' || AppState.currentState !== 'active') return;
            try {
                const [{ consumeNotificationPermissionRecoveryNeeded }, { Modal }, { t }] = await withTimeout(
                    () => Promise.all([import('./notificationPermissionJournal'), import('@/modal'), import('@/text')]),
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

        const performPermissionAction = async (actionParams: {
            sessionId: string;
            requestId: string;
            action: 'allow' | 'deny';
        }): Promise<void> => {
            const { sessionAllow, sessionDeny } = await import('@/sync/ops');
            if (actionParams.action === 'allow') {
                await sessionAllow(actionParams.sessionId, actionParams.requestId, undefined, undefined, 'approved');
            } else {
                await sessionDeny(
                    actionParams.sessionId,
                    actionParams.requestId,
                    undefined,
                    undefined,
                    'denied',
                    'Denied from notification',
                );
            }
        };

        const pendingAction = getPendingNotificationAction();
        if (pendingAction && Platform.OS === 'android') {
            // Old versions queued actions across server switches. Do not replay an
            // old decision when adopting background actions: require in-app review.
            clearPendingNotificationAction();
            fireAndForget(withTimeout(
                () => import('./notificationPermissionJournal'), EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS, 'notification recovery module load',
            ).then(({ markNotificationPermissionRecoveryNeeded }) => {
                markNotificationPermissionRecoveryNeeded();
            }), {
                tag: 'notificationPermissionRecovery',
                logToConsole: false,
                onError: () => { console.warn('[notifications] Permission action recovery storage unavailable'); },
            });
            console.warn('[notifications] Saved permission action requires in-app review');
        }
        if (pendingAction && Platform.OS !== 'android') {
            const active = normalizeServerUrl(getActiveServerUrl());
            if (normalizeServerUrl(pendingAction.serverUrl) === active) {
                clearPendingNotificationAction();
                fireAndForget((async () => {
                    try {
                        await performPermissionAction({
                            sessionId: pendingAction.sessionId,
                            requestId: pendingAction.requestId,
                            action: pendingAction.action,
                        });
                    } catch {
                        // best-effort; navigation still proceeds
                    }
                    navigateToSessionRoute({ router, sessionId: pendingAction.sessionId, refreshAuth: refreshAuthRef.current });
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
                fireAndForget(executeNotificationPermissionAction(parsed, { allowExecution }).then(showRecoveryIfActive), { tag: 'notificationPermissionAction' });
                // A live press stays where the user is; the executor owns the decision.
                if (allowExecution) return;
                // A saved response reached us only because its press launched the app
                // (foreground fallback). It never executes, so take the user to the
                // session to review the current request through the ordinary tap
                // navigation and its server-safety rules, with no auto-send.
                parsed = { ...parsed, permissionAction: null, isOpenAction: true };
            }

            if (parsed.dedupeKey) {
                const handled = handledNotificationResponseKeysRef.current;
                if (handled.size > 512) {
                    handled.clear();
                }
                if (handled.has(parsed.dedupeKey)) return;
                handled.add(parsed.dedupeKey);
            }

            if (!parsed.route) return;

            const route = parsed.route;
            const serverUrl = parsed.serverUrl;
            const routeToServerSettingsForUrl = (url: string) => {
                router.push(`/settings/server?url=${encodeURIComponent(url)}&source=notification`);
            };

            // Permission action buttons are security-sensitive. Only perform allow/deny when:
            // - the server is already active, OR
            // - the server is already saved (we can switch safely), OR
            // - (otherwise) navigate only and let the user handle it in-app.
            if (parsed.permissionAction) {
                const { action, sessionId: actionSessionId, requestId: actionRequestId } = parsed.permissionAction;
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
                                    router.push(route);
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

                    setPendingNotificationAction({
                        serverUrl: saved.serverUrl,
                        sessionId: actionSessionId,
                        requestId: actionRequestId,
                        action,
                    });
                    fireAndForget((async () => {
                        try {
                            await setActiveServerAndSwitch({
                                serverId: saved.id,
                                scope: 'device',
                                refreshAuth: refreshAuthRef.current,
                            });
                            clearPendingNotificationAction();
                            try {
                                await performPermissionAction({ sessionId: actionSessionId, requestId: actionRequestId, action });
                            } catch {
                                // best-effort
                            }
                            navigateToSessionRoute({ router, sessionId: actionSessionId, refreshAuth: refreshAuthRef.current });
                        } catch {
                            // keep pending notification action as fallback
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
                                router.push(route);
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
                                router.push(route);
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
                const { action, sessionId: actionSessionId, requestId: actionRequestId } = parsed.permissionAction;
                fireAndForget((async () => {
                    try {
                        await performPermissionAction({ sessionId: actionSessionId, requestId: actionRequestId, action });
                    } catch {
                        // best-effort
                    }
                    navigateToSessionRoute({ router, sessionId: actionSessionId, refreshAuth: refreshAuthRef.current });
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
