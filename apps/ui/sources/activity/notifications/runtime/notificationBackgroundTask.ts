import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS } from '@/utils/platform/loadExpoNotifications';
import { withTimeout } from '@/utils/timing/time';
import { markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';

export const NOTIFICATION_BACKGROUND_TASK_NAME = 'happier-notification-actions';

// Required synchronously, only on Android, inside the guarded entry-point bootstrap.
if (!TaskManager.isTaskDefined(NOTIFICATION_BACKGROUND_TASK_NAME)) {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_BACKGROUND_TASK_NAME, runNotificationBackgroundTask);
}

export async function runNotificationBackgroundTask(
    body: unknown,
    importActions: () => Promise<typeof import('./notificationPermissionActions')> = () => import('./notificationPermissionActions'),
): Promise<void> {
    try {
        const { handleNotificationBackgroundTask } = await withTimeout(
            importActions, EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS, 'notification action module load',
        );
        // Bound only loading here. Execution owns its preflight/issuance fence;
        // an outer execution timeout could misreport a possibly issued action.
        await handleNotificationBackgroundTask(body);
    } catch {
        console.warn('[notifications] Permission task runtime unavailable; open Happier to review');
        try {
            markNotificationPermissionRecoveryNeeded();
        } catch {
            console.warn('[notifications] Permission action recovery storage unavailable');
        }
    }
}

export async function registerNotificationBackgroundTask(): Promise<boolean> {
    if (!await TaskManager.isAvailableAsync()) return false;
    await Notifications.registerTaskAsync(NOTIFICATION_BACKGROUND_TASK_NAME);
    return true;
}
