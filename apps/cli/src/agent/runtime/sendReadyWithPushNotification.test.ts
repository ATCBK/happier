import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { accountSettingsParse, type LiveActivityRemoteUpdateRequestV1 } from '@happier-dev/protocol'

import { sendReadyWithPushNotification as sendReadyWithPushNotificationImpl } from '@/agent/runtime/notifications/sendReadyWithPushNotification'
import { clearActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot as publishSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot'
import { createNotificationAccountSnapshotFixture } from '@/testkit/notificationAccountSnapshot'
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures'
import * as pinnedHttp from '@/network/pinnedHttp'
import { logger } from '@/ui/logger'

const fetchSessionNotificationContext = async (sessionId: string) => {
  const session = createSessionNotificationContextFixture(sessionId)
  return { ...session, viewer: { ...session.viewer!, follow: { follows: true, notificationLevel: 'all_messages' as const,
    policy: { preset: 'everything' as const } } } }
}

function sendReadyWithPushNotification(opts: Parameters<typeof sendReadyWithPushNotificationImpl>[0]) {
  return sendReadyWithPushNotificationImpl({ ...opts, pushSender: {
    // Account mute reads are a transport boundary; these cases exercise unmuted delivery.
    readAccountSessionDeliveryMutedScopes: async () => [], ...opts.pushSender,
  } })
}

function setActiveAccountSettingsSnapshot(options: Parameters<typeof createNotificationAccountSnapshotFixture>[0] = {}) {
  publishSnapshot(createNotificationAccountSnapshotFixture({ ...options,
    settingsVersion: options.settingsVersion ?? (getActiveAccountSettingsSnapshot()?.settingsVersion ?? 0) + 1,
  }))
}

function createSessionStub(sessionId = 'session-1') {
  return {
    sessionId,
    enqueueSessionEventCommitted: vi.fn(async () => ({ persisted: true, delivered: false })),
  }
}

describe('sendReadyWithPushNotification', () => {
  beforeEach(() => { setActiveAccountSettingsSnapshot({}) })
  afterEach(() => {
    vi.restoreAllMocks()
    clearActiveAccountSettingsSnapshot()
    vi.unstubAllGlobals()
  })

  it('emits ready event and sends push notification', async () => {
    const sendToAllDevices = vi.fn()
    const session = createSessionStub('session-123')

    await sendReadyWithPushNotification({
      session: session as any,
      pushSender: { fetchSessionNotificationContext, sendToAllDevices },
      waitingForCommandLabel: 'Qwen Code',
      logPrefix: '[Qwen]',
    })

    expect(session.enqueueSessionEventCommitted).toHaveBeenCalledWith({ type: 'ready', ownerActivityDelivery: 'rich_sender' })
    await vi.waitFor(() => expect(sendToAllDevices).toHaveBeenCalled())
    expect(sendToAllDevices).toHaveBeenCalledWith(
      'Qwen Code',
      'Qwen Code is waiting for your command',
      { sessionId: 'session-123' },
      expect.any(Object),
    )
  })

  it('uses the latest assistant preview text when enabled', async () => {
    const sendToAllDevices = vi.fn()
    const session = createSessionStub('session-123')

    await sendReadyWithPushNotification({
      session: session as any,
      pushSender: { fetchSessionNotificationContext, sendToAllDevices },
      waitingForCommandLabel: 'Qwen Code',
      logPrefix: '[Qwen]',
      sessionTitle: 'Review branch',
      assistantPreviewText: 'The branch is ready to review.',
      includeAssistantPreviewText: true,
    })

    await vi.waitFor(() => expect(sendToAllDevices).toHaveBeenCalled())
    expect(sendToAllDevices).toHaveBeenCalledWith(
      'Review branch',
      'The branch is ready to review.',
      { sessionId: 'session-123' },
      expect.any(Object),
    )
  })

  it('falls back to waiting text when assistant preview text is disabled', async () => {
    setActiveAccountSettingsSnapshot({ channels: [
      { v: 1, id: 'builtin:expo_push', kind: 'expo_push', topics: {}, readyIncludeMessageText: false },
    ] })
    const sendToAllDevices = vi.fn()
    const session = createSessionStub('session-123')

    await sendReadyWithPushNotification({
      session: session as any,
      pushSender: { fetchSessionNotificationContext, sendToAllDevices },
      waitingForCommandLabel: 'Qwen Code',
      logPrefix: '[Qwen]',
      sessionTitle: 'Review branch',
      assistantPreviewText: 'The branch is ready to review.',
      includeAssistantPreviewText: false,
    })

    await vi.waitFor(() => expect(sendToAllDevices).toHaveBeenCalled())
    expect(sendToAllDevices).toHaveBeenCalledWith(
      'Review branch',
      'Qwen Code is waiting for your command',
      { sessionId: 'session-123' },
      expect.any(Object),
    )
  })

  it('can suppress push notifications while still emitting ready event', async () => {
    setActiveAccountSettingsSnapshot({ channels: [
      { v: 1, id: 'builtin:expo_push', kind: 'expo_push', topics: {}, enabled: false },
    ] })
    const sendToAllDevices = vi.fn()
    const session = createSessionStub('session-999')

    await sendReadyWithPushNotification({
      session: session as any,
      pushSender: { fetchSessionNotificationContext, sendToAllDevices },
      waitingForCommandLabel: 'Codex',
      logPrefix: '[Codex]',
    })

    expect(session.enqueueSessionEventCommitted).toHaveBeenCalledWith({ type: 'ready', ownerActivityDelivery: 'rich_sender' })
    expect(sendToAllDevices).not.toHaveBeenCalled()
  })

  it('does not hold ready publication behind the current Follow HTTP read', async () => {
    let resolveContext!: (context: ReturnType<typeof createSessionNotificationContextFixture>) => void
    const context = new Promise<ReturnType<typeof createSessionNotificationContextFixture>>((resolve) => { resolveContext = resolve })
    const sendToAllDevices = vi.fn()
    let published = false
    const publication = sendReadyWithPushNotification({
      session: createSessionStub(),
      pushSender: { sendToAllDevices, fetchSessionNotificationContext: () => context },
      waitingForCommandLabel: 'Agent', logPrefix: '[test]',
    }).then(() => { published = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(published).toBe(true)
      expect(sendToAllDevices).not.toHaveBeenCalled()
    } finally {
      resolveContext(await fetchSessionNotificationContext('session-1'))
      await publication
    }
    await vi.waitFor(() => expect(sendToAllDevices).toHaveBeenCalledOnce())
  })

  it('honors unified attention policy when dispatching ready notifications', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; })
    const session = createSessionStub('session-policy')

    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({
        attentionDeliveryPolicyV1: {
          v: 1,
          channels: {
            expo_push: {
              events: {
                ready: { enabled: false },
              },
            },
          },
        },
      }),
      settingsVersion: 8,
      loadedAtMs: 123,
      settingsSecretsReadKeys: [],
    })

    await sendReadyWithPushNotification({
      session: session as any,
      pushSender: { fetchSessionNotificationContext, sendToAllDevicesAsync },
      waitingForCommandLabel: 'Codex',
      logPrefix: '[Codex]',
      sessionTitle: 'Review branch',
      assistantPreviewText: 'Done.',
      shouldSendPush: () => true,
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(session.enqueueSessionEventCommitted).toHaveBeenCalledWith({ type: 'ready', ownerActivityDelivery: 'rich_sender' })
    expect(sendToAllDevicesAsync).not.toHaveBeenCalled()
  })

  it('forwards ready notifications to the Live Activity remote sender', async () => {
    const sendToAllDevicesAsync = vi.fn(async () => { return true; })
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {})
    const session = createSessionStub('session-live-ready')

    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({
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
      }),
      settingsVersion: 9,
      loadedAtMs: 123,
      settingsSecretsReadKeys: [],
    })

    await sendReadyWithPushNotification({
      session: session as any,
      pushSender: { fetchSessionNotificationContext,
        serverId: 'server-a',
        sendToAllDevicesAsync,
        sendLiveActivityRemoteUpdateAsync,
      },
      waitingForCommandLabel: 'Codex',
      logPrefix: '[Codex]',
      sessionTitle: 'Review branch',
      assistantPreviewText: 'Done.',
      shouldSendPush: () => true,
    })

    await vi.waitFor(() => {
      expect(sendLiveActivityRemoteUpdateAsync).toHaveBeenCalledTimes(1)
    })

    expect(sendToAllDevicesAsync).not.toHaveBeenCalled()
    expect(sendLiveActivityRemoteUpdateAsync.mock.calls[0]?.[0]).toMatchObject({
      transportMode: 'direct_apns',
      activityKey: {
        serverId: 'server-a',
        sessionId: 'session-live-ready',
        activityName: 'HappierFocusLiveActivity',
      },
    })
  })

  it('keeps the owner on the Home leg when the runtime has no rich alert sender', async () => {
    const sendLiveActivityRemoteUpdateAsync = vi.fn(async (_request: LiveActivityRemoteUpdateRequestV1) => {})
    const session = createSessionStub('session-live-only')

    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({
        attentionDeliveryPolicyV1: {
          v: 1,
          channels: {
            expo_push: { enabled: true },
          },
          liveActivityRemoteUpdates: {
            enabled: true,
            preferredMode: 'direct_apns',
          },
        },
      }),
      settingsVersion: 10,
      loadedAtMs: 123,
      settingsSecretsReadKeys: [],
    })

    await sendReadyWithPushNotification({
      session: session as any,
      pushSender: { fetchSessionNotificationContext,
        serverId: 'server-a',
        sendLiveActivityRemoteUpdateAsync,
      },
      waitingForCommandLabel: 'Codex',
      logPrefix: '[Codex]',
    })

    expect(session.enqueueSessionEventCommitted).toHaveBeenCalledWith({
      type: 'ready',
      ownerActivityDelivery: 'home_required',
    })
  })

  it('redacts non-Axios push errors before logging', async () => {
    const session = createSessionStub('session-456')
    const pushError = new Error(
      'push unavailable for https://alice:SUPER_SECRET_PASSWORD@push.example.test/v1/send?token=secret Authorization: Bearer PUSH_SECRET',
    )
    const sendToAllDevices = vi.fn(() => {
      throw pushError
    })
    const loggerDebug = vi.spyOn(logger, 'debug')

    await sendReadyWithPushNotification({
      session: session as any,
      pushSender: { fetchSessionNotificationContext, sendToAllDevices },
      waitingForCommandLabel: 'OpenCode',
      logPrefix: '[OpenCode]',
      loggerDebug: logger.debug,
    })

    expect(session.enqueueSessionEventCommitted).toHaveBeenCalledWith({ type: 'ready', ownerActivityDelivery: 'rich_sender' })
    await vi.waitFor(() => expect(loggerDebug).toHaveBeenCalled())
    expect(sendToAllDevices).toHaveBeenCalledTimes(1)
    const [, logged] = loggerDebug.mock.calls[0] ?? []
    expect(logged).toEqual(expect.objectContaining({
      name: 'Error',
      message: 'push unavailable for https://push.example.test/v1/send Authorization: <redacted>',
    }))
    expect(JSON.stringify(logged)).not.toContain('SUPER_SECRET_PASSWORD')
    expect(JSON.stringify(logged)).not.toContain('token=secret')
    expect(JSON.stringify(logged)).not.toContain('PUSH_SECRET')
  })

  it('sanitizes axios-shaped errors before logging', async () => {
    const session = createSessionStub('session-789')
    const pushError = {
      isAxiosError: true,
      name: 'AxiosError',
      message: 'Request failed with status code 401',
      config: {
        method: 'get',
        url: 'https://api.example.test/v1/push-tokens?token=secret',
        headers: { Authorization: 'Bearer super-secret' },
      },
      response: { status: 401 },
    }
    const sendToAllDevices = vi.fn(() => {
      throw pushError
    })
    const loggerDebug = vi.spyOn(logger, 'debug')

    await sendReadyWithPushNotification({
      session: session as any,
      pushSender: { fetchSessionNotificationContext, sendToAllDevices },
      waitingForCommandLabel: 'Codex',
      logPrefix: '[Codex]',
      loggerDebug: logger.debug,
    })

    await vi.waitFor(() => expect(loggerDebug).toHaveBeenCalled())
    const [, logged] = loggerDebug.mock.calls[0] ?? []
    expect(logged).toEqual(expect.objectContaining({
      name: 'AxiosError',
      status: 401,
      method: 'GET',
      url: 'https://api.example.test/v1/push-tokens',
    }))
    expect(JSON.stringify(logged)).not.toContain('Authorization')
    expect(JSON.stringify(logged)).not.toContain('super-secret')
    expect(JSON.stringify(logged)).not.toContain('token=secret')
  })

  it('prefers the latest active account settings snapshot over stale ready gating inputs', async () => {
    const requests: pinnedHttp.PinnedHttpStreamRequest[] = []
    vi.spyOn(pinnedHttp, 'openPinnedHttpStream').mockImplementation(async (request) => {
      requests.push(request)
      return { status: 202, headers: {}, contentLength: 0, read: async () => null, cancel: () => {} }
    })
    const session = createSessionStub('session-321')

    setActiveAccountSettingsSnapshot({
      source: 'network',
      settings: accountSettingsParse({}),
      channels: [
          {
            v: 1,
            id: 'webhook-primary',
            kind: 'webhook',
            enabled: true,
            url: 'https://93.184.216.34/happier',
            topics: {
              ready: true,
              permissionRequest: false,
              userActionRequest: false,
            },
            readyIncludeMessageText: false,
            signingSecretRef: null,
          },
        ],
      settingsVersion: 7,
      loadedAtMs: 123,
      settingsSecretsReadKeys: [],
    })

    await sendReadyWithPushNotification({
      session: session as any,
      pushSender: { fetchSessionNotificationContext, sendToAllDevicesAsync: vi.fn(async () => { return true; }) },
      waitingForCommandLabel: 'Codex',
      logPrefix: '[Codex]',
      accountSettings: accountSettingsParse({
        notificationsSettingsV1: {
          v: 1,
          pushEnabled: false,
          ready: false,
          readyIncludeMessageText: false,
          permissionRequest: false,
          userActionRequest: false,
          foregroundBehavior: 'full',
        },
      }),
      sessionTitle: 'Review branch',
      assistantPreviewText: 'Done.',
      shouldSendPush: () => false,
    })

    await vi.waitFor(() => {
      expect(requests).toHaveLength(1)
    })

    expect(requests[0]).toMatchObject({
      url: 'https://93.184.216.34/happier',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
    })

  })
})
