import { describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/testkit/async/deferred';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { NotificationChannelRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { sendReadyWithPushNotification } from './sendReadyWithPushNotification';
import { createNotificationAccountSnapshotFixture } from '@/testkit/notificationAccountSnapshot';
import { createReadyNotificationDispatcher } from './createReadyNotificationDispatcher';
import type { SessionPersonalFollowCommit } from '@/api/session/sessionClientPort';

describe('ready notification Account catalog admission', () => {
  it.each([false, true])('keeps durable publication independent of its original ACK and cancellation=%s', async cancelled => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot(createNotificationAccountSnapshotFixture());
    const pending = createDeferred<SessionPersonalFollowCommit | null>();
    const sent: unknown[][] = [];
    try {
      await sendReadyWithPushNotification({ session: { sessionId: 'pending-ready',
        enqueueSessionEventCommitted: async () => ({ persisted: true, delivered: false, localId: 'pending-original', whenCommitted: pending.promise }) },
        completedTurn: { turnId: 'pending-turn' }, pushSender: {
          fetchSessionNotificationContext: async id => {
            const session = createSessionNotificationContextFixture(id);
            return { ...session, viewer: { ...session.viewer!, follow: { follows: true, notificationLevel: 'important' as const,
              policy: { preset: 'quiet' as const } } } };
          },
          readAccountSessionDeliveryMutedScopes: async () => [],
          sendToAllDevicesAsync: async (...args: unknown[]) => { sent.push(args); return true; },
        }, waitingForCommandLabel: 'Agent', logPrefix: '[pending-ready-test]' });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sent).toEqual([]);
      pending.resolve(cancelled ? null : { localId: 'pending-original', committedSequence: 17,
        personalFollow: { sourceSessionId: 'pending-ready', sourceMessage: {
          localId: 'pending-original', seq: 17, policies: [{ preset: 'everything' }],
        } } });
      if (cancelled) {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(sent).toEqual([]);
      } else {
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]?.[2]).toMatchObject({ activityEventLocalId: 'pending-original' });
      }
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });

  it.each([false, true])('joins a proven completion and private policy using the exact original (marker=%s)', async marker => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot(createNotificationAccountSnapshotFixture());
    const original = { localId: marker ? 'host-turn:task_complete' : 'ready-original', seq: 41 };
    const personalFollow = { sourceSessionId: 'ready-source', sourceMessage: { ...original, policies: [{ preset: 'everything' as const }] } };
    const events: unknown[] = [];
    const sent: unknown[][] = [];
    const dispatch = createReadyNotificationDispatcher({
      session: { sessionId: 'ready-source', enqueueSessionEventCommitted: async event => {
        events.push(event);
        return { persisted: true, delivered: true, localId: 'ready-original', committedSequence: 41, personalFollow };
      } },
      pushSender: {
        fetchSessionNotificationContext: async id => {
          const session = createSessionNotificationContextFixture(id);
          return { ...session, viewer: { ...session.viewer!, follow: { follows: true, notificationLevel: 'important' as const, policy: { preset: 'quiet' as const } } } };
        },
        readAccountSessionDeliveryMutedScopes: async () => [],
        sendToAllDevicesAsync: async (...args: unknown[]) => { sent.push(args); return true; },
      }, waitingForCommandLabel: 'Agent', logPrefix: '[ready-source-test]',
    });
    try {
      await dispatch({ assistantPreviewText: 'Captured completed answer', completedTurn: { turnId: 'host-turn',
        ...(marker ? { original: { localId: original.localId, committedSequence: original.seq, personalFollow } } : {}) } });
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(events).toEqual([{ type: 'ready', ownerActivityDelivery: 'rich_sender',
        ...(!marker ? { completedTurnId: 'host-turn' } : {}) }]);
      expect(sent[0]?.[2]).toMatchObject({ sessionId: 'ready-source', activityEventLocalId: original.localId });
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });

  it('retains committed ready custody without borrowing the Account activated during transcript commit', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const settings = accountSettingsParse({});
    const catalog = { status: 'ready' as const, revision: 1, diagnostics: [], channels: [
      NotificationChannelRecordV1Schema.parse({ v: 1, id: 'builtin:expo_push', kind: 'expo_push', topics: {} }),
    ] };
    const activate = (scopeKey: string) => setActiveAccountSettingsSnapshot({ settings, source: 'network', rawSettings: {},
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey, notificationChannelCatalog: catalog });
    activate('ready-account-a');
    const settled = createDeferred<void>();
    const delivered: string[] = [];
    const committed: unknown[] = [];
    try {
      await sendReadyWithPushNotification({ session: { sessionId: 'ready-catalog-session',
        enqueueSessionEventCommitted: async event => {
          committed.push(event);
          // The durable transcript transport completes after another Account
          // activates. Reusing Settings bytes must not transfer the Session.
          activate('ready-account-b');
          return { persisted: true, delivered: true, localId: 'ready-catalog-event', committedSequence: 1 };
        } }, pushSender: {
          fetchSessionNotificationContext: async sessionId => createSessionNotificationContextFixture(sessionId),
          readAccountSessionDeliveryMutedScopes: async () => [],
          sendToAllDevices: title => { delivered.push(title); settled.resolve(); },
        }, waitingForCommandLabel: 'Codex', logPrefix: '[ready-catalog-test]',
        loggerDebug: () => settled.resolve() });
      await settled.promise;
      expect(delivered).toEqual([]);
      expect(committed).toEqual([{ type: 'ready', ownerActivityDelivery: 'rich_sender' }]);
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });

  it('retains committed ready custody but never sends legacy push when its Account catalog is missing', async () => {
    resetActiveAccountSettingsSnapshotForTests();
    const settled = createDeferred<void>();
    const delivered: string[] = [];
    const committed: unknown[] = [];
    try {
      await sendReadyWithPushNotification({ session: { sessionId: 'ready-catalog-session',
        enqueueSessionEventCommitted: async event => {
          committed.push(event);
          return { persisted: true, delivered: true, localId: 'ready-catalog-event', committedSequence: 1 };
        } }, pushSender: {
          fetchSessionNotificationContext: async sessionId => createSessionNotificationContextFixture(sessionId),
          readAccountSessionDeliveryMutedScopes: async () => [],
          sendToAllDevices: title => { delivered.push(title); settled.resolve(); },
        }, waitingForCommandLabel: 'Codex', logPrefix: '[ready-catalog-test]',
        loggerDebug: () => settled.resolve() });
      await settled.promise;
      expect(delivered).toEqual([]);
      expect(committed).toEqual([{ type: 'ready', ownerActivityDelivery: 'rich_sender' }]);
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });
});
