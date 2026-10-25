import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
// Warm the real Account/lifecycle graph during collection, outside behavior
// deadlines; each case still constructs and retires its own actual owners.
await loadSyncSingletonForTests();
await Promise.all([
  import('./voiceSessionLifecycleController'),
  import('@/voice/adapters/localDirect/localDirectAdapter'),
]);


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
  await resetVoiceSessionRuntimeStateForTests();
});

describe('voiceSessionStore', () => {
  it('retains the failed or ended target for default restart while explicit Home Brief stays Global', async () => {
    const store = await import('./voiceSessionStore');
    const { resolveVoiceIdleTarget } = await import('@/voice/runtime/voiceTargetStore');
    const accountScope = { serverId: 'home-a', accountId: 'account-a' };
    const targetSessionAddress = { serverId: 'home-a', sessionId: 'coding-session' };
    const snapshot = { adapterId: 'local_conversation', sessionId: '__voice_agent__', status: 'connected' as const,
      mode: 'listening' as const, canStop: true };
    for (const failure of [true, false]) {
      store.setVoiceSessionSnapshot(snapshot, null, { accountScope, targetSessionAddress, conversationScope: null });
      store.setVoiceSessionSnapshot({ ...snapshot, status: 'disconnected', mode: 'idle', canStop: false,
        ...(failure ? { errorCode: 'provider_error', errorRecoveryAction: 'retry' as const } : {}) });
      const restartTarget = store.getVoiceSessionRestartTarget('local_conversation', accountScope);
      const facts = { scopeDefault: 'global' as const, allowsGlobalStart: true,
        focusedSessionAddress: { serverId: 'home-b', sessionId: 'other' }, lastFocusedSessionAddress: null, restartTarget };
      expect(resolveVoiceIdleTarget({ ...facts, intent: { kind: 'default' } })).toEqual({ kind: 'session', sessionAddress: targetSessionAddress });
      expect(resolveVoiceIdleTarget({ ...facts, intent: { kind: 'global' } })).toEqual({ kind: 'global' });
      expect(store.getVoiceSessionRestartTarget('other-provider', accountScope)).toBeNull();
      expect(store.getVoiceSessionRestartTarget('local_conversation', { ...accountScope, accountId: 'account-b' })).toBeNull();
    }
  });
  it('keeps accepted Voice input scoped to its captured attempt and Account lifetime through End', async () => {
    const account = await serveAccountHomes({ homes: [{ key: 'voice', serverUrl: 'https://voice-store.test', accountId: 'account-a' }],
      route: () => undefined });
    const disconnect = await account.restoreActiveConnection();
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    expect(lifetime).not.toBeNull();
    if (!lifetime) throw new Error('Restored Voice Account lifetime unavailable');
    try {
    const store = await import('./voiceSessionStore');
    const binding = { adapterId: 'local_direct', controlSessionId: 'control', conversationSessionId: 'conversation',
      conversationSessionAddress: { serverId: account.homes.voice!.id, sessionId: 'conversation' }, targetSessionAddress: null,
      transcriptMode: 'native_session' as const, updatedAt: 1 };
    const start = () => store.setVoiceSessionSnapshot({ adapterId: binding.adapterId, sessionId: binding.controlSessionId,
      status: 'connected', mode: 'listening', canStop: true }, binding, { accountScope: lifetime.scope, conversationScope: { kind: 'voice_home' } });
    const end = () => store.setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    start();
    const oldAttemptId = store.getVoiceSessionPresentedAttemptId()!;
    end();
    start();
    store.recordVoiceSessionFirstSuccessInput({ attemptId: oldAttemptId, lifetime, conversationSessionId: 'conversation', localId: 'old-input' });
    expect(store.getVoiceSessionFirstSuccessInputIds()).toEqual([]);
    const attemptId = store.getVoiceSessionPresentedAttemptId()!;
    store.recordVoiceSessionFirstSuccessInput({ attemptId, lifetime, conversationSessionId: 'other', localId: 'other-input' });
    expect(store.getVoiceSessionFirstSuccessInputIds()).toEqual([]);
    end();
    store.recordVoiceSessionFirstSuccessInput({ attemptId, lifetime, conversationSessionId: 'conversation', localId: 'current-input' });
    expect(store.getVoiceSessionFirstSuccessInputIds()).toEqual(['current-input']);
    store.recordVoiceSessionFirstSuccess(attemptId, lifetime);
    expect(store.getVoiceSessionFirstSuccessAttemptId()).toBe(attemptId);
    expect(store.getVoiceSessionFirstSuccessInputIds()).toEqual([]);
    store.recordVoiceSessionFirstSuccessInput({ attemptId, lifetime, conversationSessionId: 'conversation', localId: 'later-input' });
    expect(store.getVoiceSessionFirstSuccessInputIds()).toEqual([]);
    await disconnect();
    expect(lifetime.isCurrent()).toBe(false);
    expect(store.getVoiceSessionFirstSuccessAttemptId()).toBeNull();
    expect(store.getVoiceSessionFirstSuccessInputIds()).toEqual([]);
    } finally {
      await disconnect();
      await account.dispose();
    }
  });
  it('publishes changes to the applied voice and clears it when the attempt is no longer connected', async () => {
    const store = await import('./voiceSessionStore');
    const snapshot = { adapterId: 'realtime', sessionId: 's1', status: 'connected' as const, mode: 'listening' as const, canStop: true };
    store.setVoiceSessionSnapshot(snapshot);
    const first = store.getVoiceSessionSnapshot();
    const inUseVoice = { providerContributionId: 'happier.openai/realtime', settingFieldPath: 'voice', value: 'coral', displayName: 'Coral' };
    const preparedInstructionsFor = { serverId: 'home', sessionId: 'bound' };
    store.setVoiceSessionSnapshot({ ...snapshot, inUseVoice, preparedInstructionsFor });
    expect(store.getVoiceSessionSnapshot()).not.toBe(first);
    expect(store.getVoiceSessionSnapshot()).toHaveProperty('inUseVoice', inUseVoice);
    expect(store.getVoiceSessionSnapshot()).toHaveProperty('preparedInstructionsFor', preparedInstructionsFor);
    store.setVoiceSessionSnapshot({ ...snapshot, inUseVoice, preparedInstructionsFor, status: 'disconnected', canStop: false });
    expect(store.getVoiceSessionSnapshot().inUseVoice).toBeUndefined();
    expect(store.getVoiceSessionSnapshot().preparedInstructionsFor).toBeUndefined();
  });
  it('retains the last ended exact conversation independently of later binding removal or route changes', async () => {
    const store = await import('./voiceSessionStore');
    const conversationSessionAddress = { serverId: 'home-a', sessionId: 'conversation' };
    const targetSessionAddress = { serverId: 'home-a', sessionId: 'coding-session' };
    const accountScope = { serverId: 'home-a', accountId: 'account-a' };
    const conversationScope = { kind: 'session_root' as const, sessionRootId: 'coding-session' };
    store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 'control', status: 'connected', mode: 'listening', canStop: true }, {
      adapterId: 'local_direct', controlSessionId: 'control', conversationSessionId: 'conversation',
      conversationSessionAddress, targetSessionAddress, transcriptMode: 'native_session', updatedAt: 1,
    }, { accountScope, conversationScope });
    store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    expect(store.getVoiceSessionEndedAttempt()).toMatchObject({
      conversationSessionAddress, targetSessionAddress, accountScope, conversationScope,
      transcriptMode: 'native_session', reason: { kind: 'disconnected' },
    });
    store.setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    expect(store.getVoiceSessionEndedAttempt()?.conversationSessionAddress).toEqual(conversationSessionAddress);
  });
  it('captures a direct-session target and Account independently of a conversation binding and retains the admitted scope', async () => {
    const store = await import('./voiceSessionStore');
    const targetSessionAddress = { serverId: 'home-direct', sessionId: 'coding-session' };
    const accountScope = { serverId: targetSessionAddress.serverId, accountId: 'account-a' };
    const snapshot = { adapterId: 'local_conversation', sessionId: targetSessionAddress.sessionId,
      status: 'connected' as const, mode: 'listening' as const, canStop: true };
    store.setVoiceSessionSnapshot(snapshot, null, { accountScope, targetSessionAddress, conversationScope: null });
    // A later profile/route projection cannot relabel the admitted attempt.
    store.setVoiceSessionSnapshot(snapshot, null, { accountScope: { ...accountScope, accountId: 'account-b' },
      targetSessionAddress: { ...targetSessionAddress, sessionId: 'other-session' }, conversationScope: null });
    store.setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    expect(store.getVoiceSessionEndedAttempt()).toMatchObject({ targetSessionAddress, accountScope,
      conversationSessionAddress: null, conversationScope: null, transcriptMode: null });
    store.setVoiceSessionSnapshot({ ...snapshot, sessionId: 'next-session' });
    store.setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    expect(store.getVoiceSessionEndedAttempt()).toMatchObject({ targetSessionAddress: null, accountScope: null });
  });
  it('does not disclose a direct-session target whose captured Account belongs to another Home', async () => {
    const store = await import('./voiceSessionStore');
    store.setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'coding-session', status: 'connected', mode: 'listening', canStop: true }, null,
      { accountScope: { serverId: 'other-home', accountId: 'account-a' },
        targetSessionAddress: { serverId: 'home-direct', sessionId: 'coding-session' }, conversationScope: null });
    store.setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    expect(store.getVoiceSessionEndedAttempt()).toMatchObject({ targetSessionAddress: null, accountScope: null });
  });
  it('does not attach a same-control-id binding from another Home to a direct-session attempt', async () => {
    const store = await import('./voiceSessionStore');
    const targetSessionAddress = { serverId: 'home-direct', sessionId: 'coding-session' };
    const accountScope = { serverId: targetSessionAddress.serverId, accountId: 'account-a' };
    store.setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: targetSessionAddress.sessionId,
      status: 'connected', mode: 'listening', canStop: true }, {
      adapterId: 'local_conversation', controlSessionId: targetSessionAddress.sessionId, conversationSessionId: 'other-conversation',
      conversationSessionAddress: { serverId: 'other-home', sessionId: 'other-conversation' },
      targetSessionAddress: null, transcriptMode: 'native_session', updatedAt: 1,
    }, { accountScope, targetSessionAddress, conversationScope: null });
    store.setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    expect(store.getVoiceSessionEndedAttempt()).toMatchObject({ targetSessionAddress, accountScope, conversationSessionAddress: null });
  });
  it('records an attempt that ended cleanly, never a failure, and forgets it at the next start or on dismiss', async () => {
    const store = await import('./voiceSessionStore');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const seen: unknown[] = [];
      const unsubscribe = store.subscribeToVoiceSessionEndedAttempt(() => seen.push(store.getVoiceSessionEndedAttempt()));
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connected', mode: 'listening', canStop: true });
      expect(store.getVoiceSessionEndedAttempt()).toBeNull();
      const attemptId = store.getVoiceSessionAttemptId();
      now.mockReturnValue(253_000);
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      expect(store.getVoiceSessionEndedAttempt()).toEqual({ attemptId, sessionId: 's1', adapterId: 'local_direct', startedAt: 1_000, endedAt: 253_000,
        reason: { kind: 'disconnected' }, conversationSessionAddress: null, targetSessionAddress: null, transcriptMode: null,
        accountScope: null, conversationScope: null });
      expect(seen).toHaveLength(1);

      // A new start replaces the ended fact; a failure is its own state, not "ended".
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's2', status: 'connecting', mode: 'idle', canStop: true });
      expect(store.getVoiceSessionEndedAttempt()).toBeNull();
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's2', status: 'error', mode: 'idle', canStop: false });
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      expect(store.getVoiceSessionEndedAttempt()).toBeNull();

      // Provider recovery may carry its failure on a disconnected snapshot.
      // That is still a failure, never a clean End/approval-after-End moment.
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 'failed-disconnect', status: 'connected', mode: 'listening', canStop: true });
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
        errorCode: 'microphone_permission_denied', errorPresentation: 'permission_required' });
      expect(store.getVoiceSessionEndedAttempt()).toBeNull();

      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's3', status: 'connected', mode: 'listening', canStop: true });
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      expect(store.getVoiceSessionEndedAttempt()).not.toBeNull();
      store.dismissVoiceSessionEndedAttempt();
      expect(store.getVoiceSessionEndedAttempt()).toBeNull();
      unsubscribe();
    } finally { now.mockRestore(); }
  });

  it('keeps one observed attempt start time through reconnect and resets it only for a new attempt', async () => {
    const store = await import('./voiceSessionStore');
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
      expect(store.getVoiceSessionAttemptStartedAt?.()).toBe(1000);
      now.mockReturnValue(5000);
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connected', mode: 'listening', canStop: true });
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', presentationState: 'reconnecting', mode: 'idle', canStop: true });
      expect(store.getVoiceSessionAttemptStartedAt?.()).toBe(1000);
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      expect(store.getVoiceSessionAttemptStartedAt?.()).toBeNull();
      store.setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
      expect(store.getVoiceSessionAttemptStartedAt?.()).toBe(5000);
    } finally { now.mockRestore(); }
  });

  it('mints one canonical attempt id per inactive-to-active start and keeps it through reconnect churn', async () => {
    const {
      getVoiceSessionAttemptId,
      setVoiceSessionSnapshot,
    } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
    const firstAttemptId = getVoiceSessionAttemptId();
    expect(firstAttemptId).toBeTypeOf('string');

    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connected', mode: 'listening', canStop: true });
    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
    expect(getVoiceSessionAttemptId()).toBe(firstAttemptId);

    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    expect(getVoiceSessionAttemptId()).toBeNull();
    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connecting', mode: 'idle', canStop: true });
    expect(getVoiceSessionAttemptId()).not.toBe(firstAttemptId);
  });

  it('mints a new attempt when the active control session changes without a disconnected publication', async () => {
    const { getVoiceSessionAttemptId, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's1', status: 'connected', mode: 'listening', canStop: true });
    const firstAttemptId = getVoiceSessionAttemptId();
    setVoiceSessionSnapshot({ adapterId: 'local_direct', sessionId: 's2', status: 'connecting', mode: 'idle', canStop: true });
    expect(getVoiceSessionAttemptId()).not.toBe(firstAttemptId);
  });

  it('does not rerender subscribers when setVoiceSessionSnapshot receives an identical snapshot', async () => {

    const { useVoiceSessionSnapshot } = await import('./voiceSession');
    const { setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    let renders = 0;

    function Test() {
      useVoiceSessionSnapshot();
      renders += 1;
      return React.createElement('div');
    }

    const baseline = {
      adapterId: null,
      sessionId: null,
      status: 'disconnected' as const,
      mode: 'idle' as const,
      canStop: false,
    };

    const snap = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected' as const,
      mode: 'idle' as const,
      canStop: true,
    };

    await act(async () => {
      setVoiceSessionSnapshot(baseline);
    });

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(React.createElement(Test))).tree;

    await act(async () => {
      setVoiceSessionSnapshot(snap);
    });
    const afterFirstSet = renders;

    await act(async () => {
      setVoiceSessionSnapshot(snap);
    });

    expect(renders).toBe(afterFirstSet);

    await act(async () => {
      tree.unmount();
    });
  });

  it('clears error fields when the next snapshot omits them', async () => {

    const { setVoiceSessionSnapshot, getVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot({
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'error',
      mode: 'idle',
      canStop: true,
      errorCode: 'device_stt_start_failed',
      errorMessage: 'device_stt_start_failed',
      errorRecoveryAction: 'open_settings',
      errorPresentation: 'permission_required',
    });

    setVoiceSessionSnapshot({
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    const snap = getVoiceSessionSnapshot();
    expect(snap.errorCode).toBeUndefined();
    expect(snap.errorMessage).toBeUndefined();
    expect(snap.errorRecoveryAction).toBeUndefined();
    expect(snap.errorPresentation).toBeUndefined();
  });

  it('publishes reconnecting and interrupted presentation-only changes', async () => {
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const baseline = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connecting' as const,
      mode: 'idle' as const,
      canStop: true,
    };

    setVoiceSessionSnapshot(baseline);
    setVoiceSessionSnapshot({ ...baseline, presentationState: 'reconnecting' });
    expect(getVoiceSessionSnapshot().presentationState).toBe('reconnecting');

    setVoiceSessionSnapshot({ ...baseline, presentationState: 'interrupted' });
    expect(getVoiceSessionSnapshot().presentationState).toBe('interrupted');
  });

  it('canonicalizes adapter and session ids when storing a snapshot', async () => {

    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');

    setVoiceSessionSnapshot({
      adapterId: ' local_direct ',
      sessionId: ' session-1 ',
      status: 'connected',
      mode: 'idle',
      canStop: true,
    });

    expect(getVoiceSessionSnapshot().adapterId).toBe('local_direct');
    expect(getVoiceSessionSnapshot().sessionId).toBe('session-1');
  });

  it('prefers the lifecycle-controller snapshot over a stale published store snapshot', async () => {
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const { setVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
    const controllerSnapshot = {
      adapterId: 'local_conversation', sessionId: 'runtime-session',
      status: 'connected' as const, mode: 'listening' as const, canStop: true,
    };
    // Construct the real lifecycle from the public current projection before
    // a stale store publication arrives; no copied lifecycle methods or readers.
    setVoiceSessionSnapshot(controllerSnapshot);
    const controller = createVoiceSessionLifecycleController();
    await act(async () => {
      setVoiceSessionSnapshot({ adapterId: 'local_conversation', sessionId: 'stale-session',
        status: 'disconnected', mode: 'idle', canStop: false });
      setVoiceSessionLifecycleController(controller);
    });
    expect(getVoiceSessionSnapshot()).toEqual(controllerSnapshot);
    await act(async () => {
      setVoiceSessionLifecycleController(null);
      await controller.dispose();
    });
  });

  it('resets the voice session runtime globals between specs', async () => {
    const voiceSessionStoreModule = await import('./voiceSessionStore');
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = voiceSessionStoreModule;
    const { getVoiceSessionLifecycleController, setVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    const { createVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleController');
    const { getVoiceAdapterRegistry, registerVoiceAdapters } = await import('./voiceAdapterRegistry');
    const { createLocalDirectVoiceAdapter } = await import('@/voice/adapters/localDirect/localDirectAdapter');
    registerVoiceAdapters([createLocalDirectVoiceAdapter()]);
    const activeSnapshot = { adapterId: 'local_direct', sessionId: 'runtime-session',
      status: 'connected' as const, mode: 'listening' as const, canStop: true };
    setVoiceSessionSnapshot(activeSnapshot);
    const controller = createVoiceSessionLifecycleController();
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    setVoiceSessionLifecycleController(controller);
    expect(getVoiceSessionSnapshot()).toEqual(activeSnapshot);
    expect(getVoiceSessionLifecycleController()).toBe(controller);
    expect(getVoiceAdapterRegistry().list()).toHaveLength(1);
    await voiceSessionStoreModule.resetVoiceSessionRuntimeStateForTests();
    expect(getVoiceSessionLifecycleController()).toBeNull();
    expect(getVoiceAdapterRegistry().list()).toHaveLength(0);
    expect(getVoiceSessionSnapshot()).toEqual({ adapterId: null, sessionId: null,
      status: 'disconnected', mode: 'idle', canStop: false });
  });
});

describe('voiceSessionStore continuation arrival', () => {
  it('marks only the current live attempt as arrived from another device, for that attempt\'s life', async () => {
    const store = await import('./voiceSessionStore');
    const notified: Array<string | null> = [];
    const unsubscribe = store.subscribeToVoiceSessionEndedAttempt(() => notified.push(store.getVoiceSessionArrivedAttemptId()));
    try {
      store.setVoiceSessionSnapshot({ adapterId: 'service', sessionId: 'control', status: 'connected', mode: 'listening', canStop: true });
      const attemptId = store.getVoiceSessionAttemptId();
      store.recordVoiceSessionArrival('service', 'other-control');
      expect(store.getVoiceSessionArrivedAttemptId()).toBeNull();
      store.recordVoiceSessionArrival('service', 'control');
      expect(store.getVoiceSessionArrivedAttemptId()).toBe(attemptId);
      expect(notified).toEqual([attemptId]);
      store.setVoiceSessionSnapshot({ adapterId: 'service', sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
      expect(store.getVoiceSessionArrivedAttemptId()).toBeNull();
      // A terminal attempt cannot be marked, and the next start begins unmarked.
      store.recordVoiceSessionArrival('service', 'control');
      expect(store.getVoiceSessionArrivedAttemptId()).toBeNull();
      store.setVoiceSessionSnapshot({ adapterId: 'service', sessionId: 'control-2', status: 'connecting', mode: 'idle', canStop: true });
      expect(store.getVoiceSessionArrivedAttemptId()).toBeNull();
    } finally {
      unsubscribe();
    }
  });
});
