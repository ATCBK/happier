import * as pinnedHttp from '@/network/pinnedHttp';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type LiveActivityRemoteUpdateRequestV1 } from '@happier-dev/protocol';
import { notificationSettingsSnapshotFixture as accountSettingsParse } from '@/notifications/activity/activityNotification.testkit';
import { logger } from '@/ui/logger';
import {
  resetActiveAccountSettingsSnapshotForTests,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import {
  sendPermissionRequestPushNotificationAsync,
  sendPermissionRequestPushNotificationForActiveAccount,
} from './permissionRequestPush';

const fetchSessionNotificationContext = async (sessionId: string) => createSessionNotificationContextFixture(sessionId);

describe('sendPermissionRequestPushNotificationAsync', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('does not send when permissionRequest pushes are disabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: false },
    });

    await sendPermissionRequestPushNotificationAsync({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      sessionId: 's1',
      sessionTitle: 'Fix prod issue',
      agentDisplayName: 'Claude',
      permissionId: 'p1',
      toolName: 'Read',
      settings,
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('does not send when the unified attention policy disables Expo push permission requests', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
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
    });

    await sendPermissionRequestPushNotificationAsync({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      sessionId: 's1',
      sessionTitle: 'Fix prod issue',
      agentDisplayName: 'Claude',
      permissionId: 'p1',
      toolName: 'Read',
      settings,
    });

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
  });

  it('sends when enabled', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });

    await sendPermissionRequestPushNotificationAsync({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      sessionId: 's1',
      sessionTitle: 'Fix prod issue',
      agentDisplayName: 'Claude',
      permissionId: 'p1',
      toolName: 'Read',
      settings,
    });

    expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1);
    expect(sendToAllDevicesAsync).toHaveBeenCalledWith(
      'Fix prod issue',
      'Claude asks permission to use Read',
      expect.objectContaining({ sessionId: 's1', requestId: 'p1' }),
      { sound: 'happier_urgent.wav', priority: 'high', androidSoundId: 'urgent' },
    );
  });

  it('notifies for an actual safe-yolo permission request instead of predicting Auto approval', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });

    sendPermissionRequestPushNotificationForActiveAccount({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      sessionId: 's-auto',
      permissionId: 'p-auto',
      toolName: 'Read',
      permissionMode: 'safe-yolo',
    });

    await vi.waitFor(() => expect(sendToAllDevicesAsync).toHaveBeenCalledTimes(1));
  });

  it('forwards permission requests to the Live Activity remote sender', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {});
    const settings = accountSettingsParse({
      attentionDeliveryPolicyV1: {
        v: 1,
        channels: {
          expo_push: { enabled: false },
        },
        liveActivityRemoteUpdates: {
          enabled: true,
          preferredMode: 'direct_apns',
        },
      },
    });

    await expect(sendPermissionRequestPushNotificationAsync({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [],
        serverId: 'server-a',
        sendToAllDevicesAsync,
        sendLiveActivityRemoteUpdateAsync,
      },
      sessionId: 's1',
      permissionId: 'p1',
      toolName: 'Bash',
      settings,
      toolInput: { command: 'git status --short && echo secret-token' },
    })).resolves.toBe(true);

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(sendLiveActivityRemoteUpdateAsync).toHaveBeenCalledTimes(1);
    const request = sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      transportMode: 'direct_apns',
      activityKey: {
        serverId: 'server-a',
        sessionId: 's1',
        activityName: 'HappierFocusLiveActivity',
      },
      contentState: {
        attentionState: 'permission_required',
      },
    });
    expect(request?.contentState?.previewText).toContain('git status --short && echo secret-token');
  });

  it('redacts non-Axios push errors before logging', async () => {
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const sendToAllDevicesAsync = async () => {
      throw new Error(
        'request failed for https://alice:SUPER_SECRET_PASSWORD@push.example.test/v1/send?token=secret Authorization: Bearer PUSH_SECRET',
      );
    };

    try {
      await expect(
        sendPermissionRequestPushNotificationAsync({
          pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
          sessionId: 's1',
          permissionId: 'p1',
          toolName: 'Read',
          settings,
        }),
      ).resolves.toBe(false);

      const [, logged] = debugSpy.mock.calls.find(([message]) =>
        message === '[activityNotifications] Failed to dispatch outbound notification'
      ) ?? [];
      expect(logged).toEqual(expect.objectContaining({
        name: 'Error',
        message: 'request failed for https://push.example.test/v1/send Authorization: <redacted>',
      }));
      expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD');
      expect(JSON.stringify(logged)).not.toContain('token=secret');
      expect(JSON.stringify(logged)).not.toContain('PUSH_SECRET');
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('delivers webhook requests during quiet hours when Expo push is suppressed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T12:00:00.000Z'));
    const requests: pinnedHttp.PinnedHttpStreamRequest[] = [];
    vi.spyOn(pinnedHttp, 'openPinnedHttpStream').mockImplementation(async (request) => {
      requests.push(request);
      return { status: 202, headers: {}, contentLength: 0, read: async () => null, cancel: () => {} };
    });
    const sendToAllDevicesAsync = vi.fn(async () => { return true; });
    const settings = accountSettingsParse({
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
    });

    await expect(sendPermissionRequestPushNotificationAsync({
      pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
      sessionId: 's1',
      permissionId: 'p1',
      toolName: 'Read',
      settings,
    })).resolves.toBe(true);

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it('does not throw when push sender throws', async () => {
    const settings = accountSettingsParse({
      notificationsSettingsV1: { v: 1, pushEnabled: true, ready: true, permissionRequest: true },
    });

    const sendToAllDevicesAsync = async () => {
      throw new Error('push down');
    };

    await expect(
      sendPermissionRequestPushNotificationAsync({
        pushSender: { fetchSessionNotificationContext, readAccountSessionDeliveryMutedScopes: async () => [], sendToAllDevicesAsync },
        sessionId: 's1',
        permissionId: 'p1',
        toolName: 'Read',
        settings,
      }),
    ).resolves.toBe(false);
  });
});
