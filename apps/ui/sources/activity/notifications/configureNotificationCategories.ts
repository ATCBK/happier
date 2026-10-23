import { PUSH_NOTIFICATION_ACTION_IDS, PUSH_NOTIFICATION_CATEGORY_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { t } from '@/text';
import { Platform } from 'react-native';
import { syncSessionChangedBackgroundWakeTaskRegistration } from './backgroundWake/defineSessionChangedBackgroundWakeTask';

import type { ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';

/** The category owner shared by app startup and the Guard push producer's identifiers. */
export async function configureNotificationCategories(Notifications: Pick<ExpoNotificationsModule, 'setNotificationCategoryAsync'>): Promise<void> {
    let opensAppToForeground = true;
    if (Platform.OS === 'android') {
        const registration = await syncSessionChangedBackgroundWakeTaskRegistration();
        opensAppToForeground = registration.status !== 'registered' && registration.status !== 'already_registered';
    }
    void Notifications.setNotificationCategoryAsync(PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1, [
        { identifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1, buttonTitle: t('notifications.actions.allow'), options: { opensAppToForeground } },
        { identifier: PUSH_NOTIFICATION_ACTION_IDS.permissionDenyV1, buttonTitle: t('notifications.actions.deny'), options: { opensAppToForeground, isDestructive: true } },
    ]).catch(() => {});
    void Notifications.setNotificationCategoryAsync(PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1, [
        { identifier: PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1, buttonTitle: t('notifications.actions.answer'), options: { opensAppToForeground: true } },
    ]).catch(() => {});
    void Notifications.setNotificationCategoryAsync(PUSH_NOTIFICATION_CATEGORY_IDS.guardStopWarningV1, [
        { identifier: PUSH_NOTIFICATION_ACTION_IDS.guardKeepRunningV1, buttonTitle: t('machineGuard.session.keepRunning'), options: { opensAppToForeground: true } },
        { identifier: PUSH_NOTIFICATION_ACTION_IDS.guardStopNowV1, buttonTitle: t('common.stop'), options: { opensAppToForeground: true, isDestructive: true } },
    ]).catch(() => {});
}
