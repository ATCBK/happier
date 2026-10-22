import { EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS } from '@/utils/platform/loadExpoNotifications';
import { withTimeout } from '@/utils/timing/time';

type BackgroundTaskModule = { registerNotificationBackgroundTask(): Promise<boolean> };
let registration: Promise<boolean> | undefined;

export function initializeNotificationBackgroundTask(platform: string, load: () => BackgroundTaskModule): Promise<boolean> {
    if (platform !== 'android') return Promise.resolve(false);
    if (registration) return registration;
    // One attempt per runtime. A late native success does not change category
    // capability; it is safe because BOTH callbacks use the same action owner.
    registration = (async () => {
        try {
            const supported = await withTimeout(
                () => load().registerNotificationBackgroundTask(),
                EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS,
                'notification task registration',
            );
            if (!supported) console.warn('[notifications] Background actions unavailable; using foreground actions');
            return supported;
        } catch {
            console.warn('[notifications] Background action registration unavailable; using foreground actions');
            return false;
        }
    })();
    return registration;
}

export function notificationPermissionActionsOpenApp(platform: string): Promise<boolean> {
    if (platform !== 'android') return Promise.resolve(true);
    return (registration ?? Promise.resolve(false)).then((supported) => !supported);
}

export function resetNotificationBackgroundTaskStateForTests(): void {
    registration = undefined;
}
