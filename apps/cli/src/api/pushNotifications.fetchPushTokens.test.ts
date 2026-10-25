import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { PushNotificationClient } from './pushNotifications';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { notificationCatalogFixture, notificationSettingsFixture } from '@/notifications/activity/activityNotification.testkit';

vi.mock('axios', () => {
  const isAxiosError = (err: any) => Boolean(err?.isAxiosError);
  return {
    __esModule: true,
    default: { get: vi.fn(), isAxiosError },
    isAxiosError,
  };
});

describe('PushNotificationClient.fetchPushTokens', () => {
  beforeEach(() => {
    vi.useRealTimers();
    (axios as any).get.mockReset();
    delete process.env.HAPPIER_PUSH_FETCH_TOKENS_TIMEOUT_MS;
    delete process.env.HAPPIER_PUSH_FETCH_TOKENS_FAILURE_COOLDOWN_MS;
  });

  it('passes a timeout (default) to axios.get', async () => {
    (axios as any).get.mockResolvedValue({ data: { tokens: [] } });
    const client = new PushNotificationClient('t', 'https://api.example.test');

    await client.fetchPushTokens();

    expect((axios as any).get).toHaveBeenCalledWith(
      'https://api.example.test/v1/push-tokens',
      expect.objectContaining({
        timeout: 15_000,
      }),
    );
  });

  it('supports overriding the timeout via env', async () => {
    process.env.HAPPIER_PUSH_FETCH_TOKENS_TIMEOUT_MS = '1234';

    (axios as any).get.mockResolvedValue({ data: { tokens: [] } });
    const client = new PushNotificationClient('t', 'https://api.example.test');

    await client.fetchPushTokens();

    expect((axios as any).get).toHaveBeenCalledWith(
      'https://api.example.test/v1/push-tokens',
      expect.objectContaining({
        timeout: 1234,
      }),
    );
  });

  it('short-circuits repeated fetch failures during the cooldown window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-07T00:00:00.000Z'));
    process.env.HAPPIER_PUSH_FETCH_TOKENS_FAILURE_COOLDOWN_MS = '1000';

    (axios as any).get.mockRejectedValueOnce({
      isAxiosError: true,
      message: 'server failed',
      config: { url: 'https://api.example.test/v1/push-tokens', method: 'get' },
      response: { status: 500 },
    });

    const client = new PushNotificationClient('t', 'https://api.example.test');

    await expect(client.fetchPushTokens()).rejects.toThrow('Failed to fetch push tokens: server failed');
    await expect(client.fetchPushTokens()).resolves.toEqual([]);

    expect((axios as any).get).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    (axios as any).get.mockResolvedValueOnce({ data: { tokens: [] } });

    await expect(client.fetchPushTokens()).resolves.toEqual([]);

    expect((axios as any).get).toHaveBeenCalledTimes(2);
  });
});

// Ready push is selected only for a followed Session; this suite exercises focus filtering, not Follow policy.
function followEverythingContext(context: ReturnType<typeof createSessionNotificationContextFixture>) {
  return { ...context, viewer: { ...context.viewer!, follow: { ...context.viewer!.follow, policy: { preset: 'everything' as const } } } };
}

describe('focused computer push filtering', () => {
  beforeEach(() => { vi.mocked(axios.get).mockReset(); });
  it('carries the canonical Account opt-in through real activity delivery to the HTTP boundary', async () => {
    vi.mocked(axios.get).mockImplementation(async (url) => ({ status: 200, data:
      String(url).includes('/v2/sessions/')
        ? { session: followEverythingContext(createSessionNotificationContextFixture('focus-session')) }
        : { tokens: [], suppressedByFocusedComputer: true },
    }));
    const client = new PushNotificationClient('t', 'https://api.example.test');
    const settings = notificationSettingsFixture({
      attentionDeliveryPolicyV1: { mutePhoneWhenComputerFocused: true },
      notificationChannelsV1: [{ id: 'phone-push', kind: 'expo_push', enabled: true }],
    });
    const result = await dispatchActivityNotificationAsync({
      settings,
      ...notificationCatalogFixture(settings),
      pluginNotifications: null,
      expoPushSender: client,
      fetchSessionNotificationContext: client.fetchSessionNotificationContext.bind(client),
      readAccountSessionDeliveryMutedScopes: async () => [],
      event: { topic: 'ready', sessionId: 'focus-session', waitingForCommandLabel: 'Agent' },
    });
    expect(result).toMatchObject({ attemptedChannels: 1, deliveredChannels: 0 });
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.example.test/v1/push-tokens?suppressIfComputerFocused=1', expect.anything(),
    );
  });
  it('requests fresh focus filtering only for opted-in deliveries', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { tokens: [] } });
    const client = new PushNotificationClient('t', 'https://api.example.test');
    await client.sendToAllDevicesAsync('Ready', 'Ready', undefined, { suppressIfComputerFocused: true });
    expect(axios.get).toHaveBeenLastCalledWith('https://api.example.test/v1/push-tokens?suppressIfComputerFocused=1', expect.anything());
    await client.fetchPushTokens();
    expect(axios.get).toHaveBeenLastCalledWith('https://api.example.test/v1/push-tokens', expect.anything());
  });
});
