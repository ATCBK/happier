import { describe, expect, it } from 'vitest';
import { buildGuardStopWarningPushDataV1 } from '@happier-dev/protocol/activity/webhookPayload';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { configureNotificationCategories } from './configureNotificationCategories';
import type { ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';

describe('native notification categories', () => {
    it('registers both controls for the category emitted by the real Guard producer', () => {
        const categories = new Map<string, Parameters<ExpoNotificationsModule['setNotificationCategoryAsync']>[1]>();
        configureNotificationCategories({ setNotificationCategoryAsync: async (id, actions) => {
            categories.set(id, actions); return { identifier: id, actions };
        } });
        const payload = buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'm',
            sessionId: 's', rule: 'idle_sessions', stopAt: 300_000 });
        expect(categories.get(payload.categoryId)?.map(action => action.identifier))
            .toEqual([PUSH_NOTIFICATION_ACTION_IDS.guardKeepRunningV1, PUSH_NOTIFICATION_ACTION_IDS.guardStopNowV1]);
    });
});
