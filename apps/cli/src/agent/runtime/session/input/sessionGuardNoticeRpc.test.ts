import { describe, expect, it, vi } from 'vitest';
import type { NotificationChannelCatalogSnapshotV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { Metadata } from '@/api/types';
import type { RpcHandler } from '@/api/rpc/types';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumer } from './sessionProviderInputConsumer';
import { registerSessionProviderInputAdmissionRpc } from './sessionProviderInputAdmissionRpc';
import { clearSessionGuardStateOnRunnerStart } from './sessionGuardNoticeRpc';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import type { ActivityNotificationEvent } from '@/notifications/activity/activityNotificationEvent';
import { logger } from '@/ui/logger';

function setup(options?: Readonly<{ rejectTranscript?: boolean; retireAfterRecord?: boolean;
  metadataError?: Error; notificationCatalog?: NotificationChannelCatalogSnapshotV1 }>) {
  let metadata: Metadata = { path: '', host: '', homeDir: '', happyHomeDir: '', happyLibDir: '', happyToolsDir: '' };
  let current = true;
  const records: unknown[] = [];
  const transcript: ACPMessageData[] = [];
  const notifications: unknown[] = [];
  const consumer = createSessionProviderInputConsumer({
    messageQueue: new MessageQueue2<{ id: string }, string>(() => 'hash'),
    session: { waitForMetadataUpdate: async () => false,
      materializeNextPendingMessageSafely: async () => ({ type: 'no_pending' as const }) },
  });
  const handlers = new Map<string, RpcHandler>();
  const guardSession = {
      sessionId: 'session-1',
      getMetadataSnapshot: () => metadata,
      checkCurrentPublisherAuthority: async () => current,
      updateMetadataAsCurrentPublisher: async (update: (value: Metadata) => Metadata) => {
        if (options?.metadataError) throw options.metadataError;
        metadata = update(metadata);
      },
      getStoredContentEncryptionContext: () => ({ mode: 'plain' as const }),
      upsertSessionSystemRecord: async (record: unknown) => {
        records.push(record);
        if (options?.retireAfterRecord) current = false;
      },
      enqueueAgentMessageCommitted: async (_agent: string, body: ACPMessageData) => {
        if (options?.rejectTranscript) return { persisted: false, delivered: false };
        transcript.push(body);
        return { persisted: true, delivered: true };
      },
  };
  let currentSession = guardSession;
  const guardNotice = {
    get session() { return currentSession; },
    notify: async (event: Extract<ActivityNotificationEvent, { topic: 'guard_stop_warning' | 'guard_attention' }>) => {
      if (options?.notificationCatalog) await dispatchActivityNotificationAsync({
        settings: undefined, notificationChannelCatalog: options.notificationCatalog, event, pluginNotifications: null,
      });
      notifications.push(event);
    },
    machineId: 'machine-1',
    agentId: 'test-agent',
  };
  registerSessionProviderInputAdmissionRpc({ consumer, guardNotice,
    rpcHandlerRegistrar: { registerHandler: (method, handler) => handlers.set(method, handler) } });
  const notice = async (state: unknown, sessionId = 'session-1') => {
    const handler = handlers.get('session.guard.notice');
    expect(handler, 'the current runner must admit guard notices').toBeDefined();
    return await handler!({ sessionId, state });
  };
  return { notice, records, transcript, notifications, metadata: () => metadata,
    replaceSession: (sessionId: string) => { currentSession = { ...guardSession, sessionId }; },
    clearOnStart: () => clearSessionGuardStateOnRunnerStart(guardNotice), retire: () => { current = false; } };
}

describe('runner guard notice receipt', () => {
  it('distinguishes notification admission from metadata failures without logging private error contents', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      const warning = { kind: 'stopping', stopAt: 300_000, rule: 'idle_sessions' };
      const notificationOwner = setup({ notificationCatalog: { status: 'unavailable', reason: 'unreachable' } });
      await expect(notificationOwner.notice(warning)).resolves.toEqual({ ok: false });
      expect(notificationOwner.metadata()).toHaveProperty('sessionGuardStateV1.kind', 'stopping');
      expect(debug).toHaveBeenCalledWith(expect.any(String), {
        sessionId: 'session-1', stateKind: 'stopping', phase: 'notification',
        errorClass: 'NotificationChannelCatalogUnavailableError',
        errorCode: 'notification_channel_catalog_unavailable', reason: 'unreachable',
      });
      debug.mockClear();
      // Session metadata persistence is a genuine server boundary. No private
      // server payload, arbitrary code/reason or Error message may reach logs.
      class PrivateErrorClassName extends Error {}
      const metadataOwner = setup({ metadataError: Object.assign(new PrivateErrorClassName('private metadata payload'), {
        name: 'private-error-name', code: 'private-error-code', reason: 'private-error-reason',
      }) });
      await expect(metadataOwner.notice(warning)).resolves.toEqual({ ok: false });
      expect(debug).toHaveBeenCalledWith(expect.any(String), {
        sessionId: 'session-1', stateKind: 'stopping', phase: 'metadata', errorClass: 'Error',
      });
      expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
    } finally { debug.mockRestore(); }
  });

  it('identifies a refused current-publisher check without acknowledging the notice', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      const owner = setup(); owner.retire();
      await expect(owner.notice({ kind: 'stopping', stopAt: 300_000, rule: 'idle_sessions' })).resolves.toEqual({ ok: false });
      expect(debug).toHaveBeenCalledWith(expect.any(String), {
        sessionId: 'session-1', stateKind: 'stopping', phase: 'publisher_authority', reason: 'publisher_not_current',
      });
      expect(owner.notifications).toEqual([]);
    } finally { debug.mockRestore(); }
  });

  it('records requested intent without claiming exit or freed memory before a signal', async () => {
    const owner = setup();
    await expect(owner.notice({ kind: 'stopped', at: 300_000, rule: 'memory_guard', freedBytes: 1024 })).resolves.toEqual({ ok: true });
    expect(owner.records).toMatchObject([{ content: { v: { status: 'requested' } } }]);
    expect(owner.metadata()).toHaveProperty('sessionGuardStateV1.kind', 'requested');
    expect(owner.transcript).toMatchObject([{ data: { sessionStopV1: { status: 'requested' } } }]);
  });
  it('delivers Session-custodied terminal warnings through the requester without replacing Session metadata', async () => {
    const owner = setup();
    await owner.notice({ kind: 'ceiling', bytes: 4096 });
    const before = owner.metadata().sessionGuardStateV1;
    await expect(owner.notice({ kind: 'notify_terminal_warning', terminalId: 'terminal-1',
      terminalKey: 'terminal-key-1', stopAt: 300_000, idleMs: 60_000 })).resolves.toEqual({ ok: true });
    expect(owner.metadata().sessionGuardStateV1).toEqual(before);
    expect(owner.notifications).toEqual([{ topic: 'guard_stop_warning', machineId: 'machine-1',
      terminalId: 'terminal-1', terminalKey: 'terminal-key-1', stopAt: 300_000, idleMs: 60_000, rule: 'idle_terminals' }]);
    owner.retire();
    await expect(owner.notice({ kind: 'notify_terminal_warning', terminalId: 'terminal-1',
      terminalKey: 'terminal-key-1', stopAt: 300_000 })).resolves.toEqual({ ok: false });
    expect(owner.notifications).toHaveLength(1);
  });

  it('delivers ceiling attention through the requester notification owner without changing Session presentation', async () => {
    const owner = setup();
    await owner.notice({ kind: 'stopping', stopAt: 300_000, rule: 'idle_sessions' });
    const before = owner.metadata().sessionGuardStateV1;
    await expect(owner.notice({ kind: 'notify_ceiling', notice: 'ceiling_near', memory: { usedBytes: 950, limitBytes: 1000 } })).resolves.toEqual({ ok: true });
    expect(owner.metadata().sessionGuardStateV1).toEqual(before);
    expect(owner.notifications).toMatchObject([
      { topic: 'guard_stop_warning' },
      { topic: 'guard_attention', kind: 'ceiling_near', machineId: 'machine-1', sessionId: 'session-1', memory: { usedBytes: 950, limitBytes: 1000 } },
    ]);
    owner.retire();
    await expect(owner.notice({ kind: 'notify_ceiling', notice: 'ceiling_reached' })).resolves.toEqual({ ok: false });
    expect(owner.notifications).toHaveLength(2);
  });

  it('retains the Session ceiling override across warnings, cancellation and runner startup', async () => {
    const owner = setup();
    await expect(owner.notice({ kind: 'ceiling', bytes: 4096 })).resolves.toEqual({ ok: true });
    expect(owner.metadata().sessionGuardStateV1).toEqual({ v: 1, kind: 'configured', ceilingBytes: 4096 });
    await expect(owner.notice({ kind: 'stopping', stopAt: 300_000, rule: 'idle_sessions' })).resolves.toEqual({ ok: true });
    expect(owner.metadata().sessionGuardStateV1).toMatchObject({ kind: 'stopping', ceilingBytes: 4096 });
    await owner.notice({ kind: 'clear' });
    expect(owner.metadata().sessionGuardStateV1).toEqual({ v: 1, kind: 'configured', ceilingBytes: 4096 });
    await owner.notice({ kind: 'stopped', at: 300_000, rule: 'ceiling', ceilingBytes: 4096 });
    expect(owner.records).toMatchObject([{ content: { v: { rule: 'ceiling', ceilingBytes: 4096 } } }]);
    await owner.clearOnStart();
    expect(owner.metadata().sessionGuardStateV1).toEqual({ v: 1, kind: 'configured', ceilingBytes: 4096 });
    await owner.notice({ kind: 'ceiling', bytes: null });
    await owner.clearOnStart();
    expect(owner.metadata().sessionGuardStateV1).toEqual({ v: 1, kind: 'configured', ceilingBytes: null });
    expect(owner.notifications).toHaveLength(1);
  });

  it('publishes warning, clears it, and writes a durable stop marker before reporting success', async () => {
    const owner = setup();
    await expect(owner.notice({ kind: 'stopping', stopAt: 300_000, rule: 'memory_guard' })).resolves.toEqual({ ok: true });
    expect(owner.metadata()).toHaveProperty('sessionGuardStateV1', { v: 1, kind: 'stopping', stopAt: 300_000, rule: 'memory_guard' });
    expect(owner.notifications).toEqual([{ topic: 'guard_stop_warning', machineId: 'machine-1', sessionId: 'session-1', stopAt: 300_000, rule: 'memory_guard' }]);
    await expect(owner.notice({ kind: 'clear' })).resolves.toEqual({ ok: true });
    expect(owner.metadata()).not.toHaveProperty('sessionGuardStateV1');
    await expect(owner.notice({ kind: 'stopped', at: 300_000, rule: 'memory_guard', idleMs: 7_200_000, freedBytes: 1024 })).resolves.toEqual({ ok: true });
    expect(owner.metadata()).toHaveProperty('sessionGuardStateV1.kind', 'requested');
    expect(owner.records).toEqual([{ namespace: 'activity', kind: 'session_stop.v1', localId: 'activity:session_stop:v1:300000',
      content: { t: 'plain', v: { v: 1, at: 300_000, rule: 'memory_guard', idleMs: 7_200_000, freedBytes: 1024, status: 'requested' } } }]);
    expect(owner.transcript).toMatchObject([{ type: 'event', data: {
      type: 'message', sessionStopV1: { v: 1, at: 300_000, rule: 'memory_guard', idleMs: 7_200_000, freedBytes: 1024 },
    } }]);
  });

  it('refuses wrong-session, malformed, and superseded-publisher notices without effects', async () => {
    const owner = setup();
    await expect(owner.notice({ kind: 'stopping', stopAt: 300_000, rule: 'memory_guard' }, 'another-session')).resolves.toEqual({ ok: false });
    await expect(owner.notice({ kind: 'stopping', stopAt: -1, rule: 'memory_guard' })).resolves.toEqual({ ok: false });
    owner.retire();
    await expect(owner.notice({ kind: 'stopped', at: 300_000, rule: 'memory_guard' })).resolves.toEqual({ ok: false });
    expect(owner.metadata()).not.toHaveProperty('sessionGuardStateV1');
    expect(owner.records).toEqual([]);
    expect(owner.notifications).toEqual([]);
  });

  it('does not acknowledge a stop without durable transcript custody or after losing its publisher', async () => {
    for (const options of [{ rejectTranscript: true }, { retireAfterRecord: true }]) {
      const owner = setup(options);
      await expect(owner.notice({ kind: 'stopped', at: 300_000, rule: 'memory_guard' })).resolves.toEqual({ ok: false });
      expect(owner.metadata()).not.toHaveProperty('sessionGuardStateV1');
      expect(owner.transcript).toEqual([]);
    }
  });

  it('records a Machine-policy ceiling without turning its receipt into a Session override', async () => {
    const owner = setup();
    await expect(owner.notice({ kind: 'stopped', at: 300_000, rule: 'ceiling', ceilingBytes: 8192 })).resolves.toEqual({ ok: true });
    expect(owner.records).toMatchObject([{ content: { v: { ceilingBytes: 8192 } } }]);
    expect(owner.metadata().sessionGuardStateV1).not.toHaveProperty('ceilingBytes');
    await owner.clearOnStart();
    expect(owner.metadata()).not.toHaveProperty('sessionGuardStateV1');
  });

  it('keeps notices bound to the current Session when the control owner swaps its client', async () => {
    const owner = setup();
    owner.replaceSession('session-2');
    await expect(owner.notice({ kind: 'stopping', stopAt: 300_000, rule: 'memory_guard' }, 'session-1')).resolves.toEqual({ ok: false });
    await expect(owner.notice({ kind: 'stopping', stopAt: 300_000, rule: 'memory_guard' }, 'session-2')).resolves.toEqual({ ok: true });
    expect(owner.notifications).toMatchObject([{ sessionId: 'session-2' }]);
  });

  it('clears the previous runner presentation on startup without deleting the durable stop record', async () => {
    const owner = setup();
    await owner.notice({ kind: 'stopped', at: 300_000, rule: 'memory_guard' });
    await owner.clearOnStart();
    expect(owner.metadata()).not.toHaveProperty('sessionGuardStateV1');
    expect(owner.records).toHaveLength(1);
    expect(owner.transcript).toHaveLength(1);
  });
});
