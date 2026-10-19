import * as pinnedHttp from '@/network/pinnedHttp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { notificationSettingsSnapshotFixture as accountSettingsParse } from '@/notifications/activity/activityNotification.testkit';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { PermissionRequestPushNotifier } from './permissionRequestPushNotifier';
import type { PermissionRequestPushSender } from './permissionRequestPush';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';

const fetchSessionNotificationContext = async (sessionId: string) => createSessionNotificationContextFixture(sessionId);

describe('PermissionRequestPushNotifier', () => {
  it('reevaluates admitted source policy on retries instead of retaining a stale interrupt', async () => {
    vi.useFakeTimers();
    const sendToAllDevicesAsync = vi.fn(async () => false);
    const onNotifiedAt = vi.fn();
    let selected = true;
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync,
        fetchSessionNotificationContext: async id => {
          const context = createSessionNotificationContextFixture(id);
          return { ...context, viewer: { ...context.viewer!, follow: {
            follows: true, notificationLevel: 'important' as const, policy: { preset: 'quiet' as const },
          } } };
        },
      },
      getSettings: () => accountSettingsParse({}),
      prepareRequestNotification: async () => ({ isCurrent: () => true,
        admittedRulePolicies: [{ preset: selected ? 'important' : 'quiet' }] }),
      sessionId: 'retry-policy', logPrefix: '[test]', retryDelaysMs: [100], onNotifiedAt,
    });
    try {
      notifier.notify({ permissionId: 'retry-question', toolName: 'AskUserQuestion', requestKind: 'user_action' });
      await vi.advanceTimersByTimeAsync(0);
      expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
      selected = false;
      await vi.advanceTimersByTimeAsync(100);
      expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
      expect(onNotifiedAt).not.toHaveBeenCalled();
      selected = true;
      sendToAllDevicesAsync.mockResolvedValue(true);
      notifier.notify({ permissionId: 'retry-question', toolName: 'AskUserQuestion', requestKind: 'user_action' });
      await vi.advanceTimersByTimeAsync(0);
      expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);
      expect(onNotifiedAt).toHaveBeenCalledTimes(1);
    } finally { notifier.dispose(); }
  });
  it('rechecks the question owner before delivery and keeps manager-handled questions quiet', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => true);
    let handling: 'person' | 'manager' = 'manager';
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      getSettings: () => accountSettingsParse({}),
      getRequestFollowEvent: () => ({ kind: 'needs_you', type: 'decision', mode: 'wait', handling }),
      sessionId: 's1', logPrefix: '[test]',
    });
    notifier.notify({ permissionId: 'q1', toolName: 'AskUserQuestion', requestKind: 'user_action' });
    // A skipped source-policy decision is idle, not acknowledged as a delivery.
    await vi.waitFor(() => expect(sendToAllDevicesAsync).not.toHaveBeenCalled());
    await new Promise(resolve => setImmediate(resolve));
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    handling = 'person';
    notifier.notify({ permissionId: 'q1', toolName: 'AskUserQuestion', requestKind: 'user_action' });
    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
    notifier.dispose();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('delivers full questions and choices through the notifier', async () => {
    const sendToAllDevicesAsync = vi.fn<PermissionRequestPushSender['sendToAllDevicesAsync']>(async () => { return true; });
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      getSettings: () => accountSettingsParse({ notificationsSettingsV1: { requestIncludeMessageText: true } }),
      sessionId: 's1', logPrefix: '[test]',
    });
    notifier.notify({ permissionId: 'q1', toolName: 'AskUserQuestion', toolInput: {
      questions: [{ question: 'Which environments should be updated?', multiSelect: true,
        options: [{ label: 'Production', description: 'Customer-facing deployment' }, { label: 'Staging' }],
        freeform: {} }],
    } });
    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalled());
    const body = sendToAllDevicesAsync.mock.calls[0][1];
    for (const text of ['Which environments should be updated?', 'Production', 'Customer-facing deployment', 'Staging', 'Select multiple', 'Custom answer']) expect(body).toContain(text);
    notifier.dispose();
  });

  it('does not send when disabled by settings', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
        }),
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [0],
      maxRetryMs: 10_000,
      maxEntries: 10,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'Write' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    notifier.dispose();
  });

  it('does not retry when skipped by the unified attention policy', async () => {
    vi.useFakeTimers();
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const getSettings = vi.fn(() =>
      accountSettingsParse({
        attentionDeliveryPolicyV1: {
          v: 1,
          channels: {
            expo_push: {
              events: {
                permission_request: { enabled: false },
              },
            },
          },
        },
      }),
    );
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      getSettings,
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [100],
      maxRetryMs: 10_000,
      maxEntries: 10,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'Write' });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(getSettings).toHaveBeenCalledTimes(1);
    notifier.dispose();
  });

  it('does not send user-action requests when disabled by settings', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: {
            v: 1,
            pushEnabled: true,
            ready: true,
            permissionRequest: true,
            userActionRequest: false,
          },
        }),
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [0],
      maxRetryMs: 10_000,
      maxEntries: 10,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'AskUserQuestion', requestKind: 'user_action' });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    notifier.dispose();
  });

  it('sends user-action requests even when permission-request pushes are disabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: {
            v: 1,
            pushEnabled: true,
            ready: true,
            permissionRequest: false,
            userActionRequest: true,
          },
        }),
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [0],
      maxRetryMs: 10_000,
      maxEntries: 10,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'AskUserQuestion', requestKind: 'user_action' });
    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
    notifier.dispose();
  });

  it('sends webhook requests during quiet hours when Expo push is suppressed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
    const requests: pinnedHttp.PinnedHttpStreamRequest[] = [];
    vi.spyOn(pinnedHttp, 'openPinnedHttpStream').mockImplementation(async (request) => {
      requests.push(request);
      return { status: 202, headers: {}, contentLength: 0, read: async () => null, cancel: () => {} };
    });
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const onNotifiedAt = vi.fn();
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          attentionDeliveryPolicyV1: {
            v: 1,
            quietHours: {
              enabled: true,
              timezone: 'UTC',
              windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
            },
          },
          notificationChannelsV1: [
            {
              v: 1,
              id: 'webhook-primary',
              kind: 'webhook',
              enabled: true,
              url: 'https://93.184.216.34/happier',
              topics: {
                ready: false,
                permissionRequest: true,
                userActionRequest: false,
              },
              signingSecret: {
                _isSecretValue: true,
                value: 'webhook-secret',
              },
            },
          ],
        }),
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [0],
      maxRetryMs: 10_000,
      maxEntries: 10,
      onNotifiedAt,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'Write' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.waitFor(() => expect(onNotifiedAt).toHaveBeenCalledWith('p1', Date.parse('2026-05-03T12:00:00.000Z')));
    notifier.dispose();
  });

  it('retries after failures and marks completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sendToAllDevicesAsync = vi
      .fn<PermissionRequestPushSender['sendToAllDevicesAsync']>().mockResolvedValue(true)
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce(true);

    const onNotifiedAt = vi.fn();
    let sessionTitle = 'Initial session title';
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
        }),
      getSessionTitle: () => sessionTitle,
      getAgentDisplayName: () => 'Codex',
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [100, 200],
      maxRetryMs: 10_000,
      maxEntries: 10,
      onNotifiedAt,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'Write', createdAtMs: 0 });

    // First attempt runs immediately (async; no timer).
    await vi.advanceTimersByTimeAsync(0);
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    expect(sendToAllDevicesAsync.mock.calls[0]?.[0]).toBe('Initial session title');

    // Advance to first retry.
    sessionTitle = 'Retried session title';
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(2);
    expect(sendToAllDevicesAsync.mock.calls[1]?.[0]).toBe('Retried session title');

    // Advance to second retry, which succeeds.
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(3);
    expect(sendToAllDevicesAsync.mock.calls[2]?.[1]).toBe('Codex asks permission to use Write');
    expect(onNotifiedAt).toHaveBeenCalledTimes(1);

    notifier.markCompleted('p1');
    notifier.dispose();
  });

  it('still sends when maxEntries is configured to 0 (clamped to 1)', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
        }),
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [],
      maxRetryMs: 10_000,
      maxEntries: 0,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'Write' });
    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
    notifier.dispose();
  });

  it('falls back when display context callbacks throw', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const notifier = new PermissionRequestPushNotifier({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      getSettings: () =>
        accountSettingsParse({
          notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
        }),
      getSessionTitle: () => {
        throw new Error('metadata unavailable');
      },
      getAgentDisplayName: () => {
        throw new Error('metadata unavailable');
      },
      sessionId: 's1',
      logPrefix: '[test]',
      retryDelaysMs: [],
      maxRetryMs: 10_000,
      maxEntries: 10,
    });

    notifier.notify({ permissionId: 'p1', toolName: 'Write' });
    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Session s1',
      'Agent asks permission to use Write',
      expect.objectContaining({ sessionId: 's1', requestId: 'p1' }),
      { sound: 'happier_urgent.wav', priority: 'high', androidSoundId: 'urgent' },
    ));
    notifier.dispose();
  });
});
