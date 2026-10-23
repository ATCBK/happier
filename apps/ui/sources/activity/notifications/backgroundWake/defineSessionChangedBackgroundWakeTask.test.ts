import { describe, expect, it, vi } from 'vitest';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import { PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS } from '../permission/pushNotificationAccess';

import {
    SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME,
    applySessionChangedBackgroundWakePayload,
    defineSessionChangedBackgroundWakeTask,
    readSessionChangedBackgroundWakePayload,
    syncSessionChangedBackgroundWakeTaskRegistration,
} from './defineSessionChangedBackgroundWakeTask';

// Mirrors `expo-notifications`' real `BackgroundNotificationTaskResult` enum
// (NewData = 0, NoData = 1, Failed = 2) so the stub cannot pass on values the
// platform never returns.
const BackgroundNotificationTaskResult = { NewData: 0, NoData: 1, Failed: 2 } as const;

function createTaskManager(defined = new Set<string>()) {
    const tasks = new Map<string, (payload: unknown) => Promise<unknown>>();
    return {
        tasks,
        defineTask: ((taskName: string, executor: (payload: unknown) => Promise<unknown>) => {
            defined.add(taskName);
            tasks.set(taskName, executor);
        }) as never,
        isTaskDefined: (taskName: string) => defined.has(taskName),
    };
}

describe('session_changed background wake consumer', () => {
    it('reads the wake out of the Expo and Android data-message envelopes', () => {
        const wake = { type: 'session_changed', serverId: 'srv_a', sessionId: 'session-1' };
        expect(readSessionChangedBackgroundWakePayload(wake)).toEqual(wake);
        expect(readSessionChangedBackgroundWakePayload({ data: wake })).toEqual(wake);
        expect(readSessionChangedBackgroundWakePayload({ data: { dataString: JSON.stringify(wake) } }))
            .toEqual(wake);
    });

    it('ignores every payload that is not exactly this wake', () => {
        expect(readSessionChangedBackgroundWakePayload({ data: { type: 'badge_refresh' } })).toBeNull();
        expect(readSessionChangedBackgroundWakePayload({
            data: { type: 'activity_alert', v: 2, sessionId: 'session-1' },
        })).toBeNull();
        expect(readSessionChangedBackgroundWakePayload({ data: { dataString: 'not json' } })).toBeNull();
        expect(readSessionChangedBackgroundWakePayload(undefined)).toBeNull();
    });

    it('reconciles exactly the woken Home and Session, and nothing else', async () => {
        const reconcile = vi.fn(async () => true);
        expect(await applySessionChangedBackgroundWakePayload({
            payload: { data: { type: 'session_changed', serverId: 'srv_a', sessionId: 'session-1' } },
            reconcile,
            notifications: { getPresentedNotificationsAsync: async () => [], dismissNotificationAsync: async () => {} },
        })).toEqual({ action: 'reconciled', serverId: 'srv_a', sessionId: 'session-1' });
        expect(reconcile).toHaveBeenCalledWith({
            type: 'session_changed', serverId: 'srv_a', sessionId: 'session-1',
        });
    });

    it('never reconciles for a foreign payload', async () => {
        const reconcile = vi.fn(async () => true);
        expect(await applySessionChangedBackgroundWakePayload({
            payload: { data: { type: 'badge_refresh' } },
            reconcile,
        })).toEqual({ action: 'ignore', reason: 'not_a_session_changed_wake' });
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('reports no data when the exact Home cannot produce the Session', async () => {
        expect(await applySessionChangedBackgroundWakePayload({
            payload: { type: 'session_changed', sessionId: 'session-1' },
            reconcile: async () => false,
        })).toEqual({ action: 'ignore', reason: 'session_unavailable' });
    });

    it('defines exactly one task on both push platforms, and none where it cannot run', () => {
        // Android's Firebase entry point hands a recognized wake back to the app
        // process, which runs the task-manager tasks registered here.
        for (const platformOS of ['ios', 'android'] as const) {
            const push = createTaskManager();
            expect(defineSessionChangedBackgroundWakeTask({
                taskManager: push, notifications: { BackgroundNotificationTaskResult }, platformOS,
            })).toEqual({ status: 'defined' });
            expect([...push.tasks.keys()]).toEqual([SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME]);
        }

        const web = createTaskManager();
        expect(defineSessionChangedBackgroundWakeTask({
            taskManager: web, notifications: { BackgroundNotificationTaskResult }, platformOS: 'web',
        })).toEqual({ status: 'skipped_platform' });
        expect(web.tasks.size).toBe(0);
    });

    it('maps the task outcome onto the background task result contract', async () => {
        const taskManager = createTaskManager();
        defineSessionChangedBackgroundWakeTask({
            taskManager, notifications: { BackgroundNotificationTaskResult }, platformOS: 'ios',
        });
        const executor = taskManager.tasks.get(SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME);
        expect(executor).toBeDefined();
        expect(await executor?.({ error: new Error('boom') })).toBe(BackgroundNotificationTaskResult.Failed);
        expect(await executor?.({ data: { data: { type: 'badge_refresh' } } }))
            .toBe(BackgroundNotificationTaskResult.NoData);
    });

    it('reports an unbound Android permission button for review without reconciling a wake', async () => {
        const taskManager = createTaskManager();
        defineSessionChangedBackgroundWakeTask({
            taskManager, notifications: { BackgroundNotificationTaskResult }, platformOS: 'android',
        });
        const executor = taskManager.tasks.get(SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME);
        expect(await executor?.({ data: {
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
            notification: { request: { identifier: 'legacy-request', content: { data: {
                sessionId: 'session-1', requestId: 'request-1', serverUrl: 'https://saved.example.test',
            } } } },
        } })).toBe(BackgroundNotificationTaskResult.Failed);
    });

    it('keeps background actions unavailable when their native consumer is not defined', async () => {
        const registerTaskAsync = vi.fn(async () => undefined);
        const taskManager = { isTaskRegisteredAsync: async () => false,
            isTaskDefined: () => false, isAvailableAsync: async () => true };
        expect(await syncSessionChangedBackgroundWakeTaskRegistration({ platformOS: 'android', taskManager,
            notifications: { registerTaskAsync, unregisterTaskAsync: async () => {} },
        })).toEqual({ status: 'unavailable' });
        expect(registerTaskAsync).not.toHaveBeenCalled();
    });

    it('settles stalled native registration within the notification native-call budget', async () => {
        vi.useFakeTimers();
        try {
            let result: unknown;
            void syncSessionChangedBackgroundWakeTaskRegistration({ platformOS: 'android',
                taskManager: { isTaskRegisteredAsync: async () => false,
                    isTaskDefined: () => true, isAvailableAsync: async () => true },
                notifications: { registerTaskAsync: () => new Promise(() => {}), unregisterTaskAsync: async () => {} },
            }).then(value => { result = value; });
            await vi.advanceTimersByTimeAsync(PUSH_NOTIFICATION_NATIVE_CALL_TIMEOUT_MS);
            expect(result).toEqual({ status: 'unavailable' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('registers once on each supported push platform', async () => {
        const registerTaskAsync = vi.fn(async () => undefined);
        const unregisterTaskAsync = vi.fn(async () => undefined);
        const notifications = { registerTaskAsync, unregisterTaskAsync };

        expect(await syncSessionChangedBackgroundWakeTaskRegistration({
            platformOS: 'ios', notifications, taskManager: { isTaskRegisteredAsync: async () => false,
                    isTaskDefined: () => true, isAvailableAsync: async () => true },
        })).toEqual({ status: 'registered' });
        expect(registerTaskAsync).toHaveBeenCalledWith(SESSION_CHANGED_BACKGROUND_WAKE_TASK_NAME);

        expect(await syncSessionChangedBackgroundWakeTaskRegistration({
            platformOS: 'ios', notifications, taskManager: { isTaskRegisteredAsync: async () => true,
                    isTaskDefined: () => true, isAvailableAsync: async () => true },
        })).toEqual({ status: 'already_registered' });
        expect(registerTaskAsync).toHaveBeenCalledTimes(1);

        expect(await syncSessionChangedBackgroundWakeTaskRegistration({
            platformOS: 'android', notifications, taskManager: { isTaskRegisteredAsync: async () => false,
                    isTaskDefined: () => true, isAvailableAsync: async () => true },
        })).toEqual({ status: 'registered' });
        expect(registerTaskAsync).toHaveBeenCalledTimes(2);
        expect(unregisterTaskAsync).not.toHaveBeenCalled();
    });

    it('skips registration on web without touching native task APIs', async () => {
        const registerTaskAsync = vi.fn(async () => undefined);
        const unregisterTaskAsync = vi.fn(async () => undefined);
        const isTaskRegisteredAsync = vi.fn(async () => {
            throw new Error('TaskManager.isTaskRegisteredAsync is unavailable on web');
        });

        expect(await syncSessionChangedBackgroundWakeTaskRegistration({
            platformOS: 'web',
            notifications: { registerTaskAsync, unregisterTaskAsync },
            taskManager: { isTaskRegisteredAsync, isTaskDefined: () => true, isAvailableAsync: async () => true },
        })).toEqual({ status: 'already_unregistered', reason: 'platform_unsupported' });
        expect(isTaskRegisteredAsync).not.toHaveBeenCalled();
        expect(registerTaskAsync).not.toHaveBeenCalled();
        expect(unregisterTaskAsync).not.toHaveBeenCalled();
    });
});
