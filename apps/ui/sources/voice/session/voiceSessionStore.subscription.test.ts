import { describe, expect, it, vi } from 'vitest';
import { createVoiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import { useVoiceConversationRuntimeStore } from '@/voice/runtime/machine/voiceConversationRuntimeStore';

describe('voiceSessionStore subscriptions', () => {
  it('publishes Retry availability and withdrawal during the real reconnect projection', async () => {
    vi.resetModules();
    const { getVoiceSessionSnapshot, setVoiceSessionSnapshot, subscribeToVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const machine = createVoiceConversationRuntimeMachine();
    machine.reset();
    const owner = { adapterId: 'realtime-test', controlSessionId: 'session-1' };
    const publish = () => setVoiceSessionSnapshot(deriveLocalVoiceSessionSnapshot(owner.adapterId, 'realtime', machine.getSnapshot()));
    const unsubscribeMachine = useVoiceConversationRuntimeStore.subscribe(publish);
    machine.transitionToConnecting(owner);
    machine.transitionToConnected(owner);
    machine.setReconnecting({ ...owner, reconnecting: true, retryAvailable: false });
    const unavailable = getVoiceSessionSnapshot();
    const listener = vi.fn();
    const unsubscribe = subscribeToVoiceSessionSnapshot(listener);
    try {
      machine.setReconnecting({ ...owner, reconnecting: true, retryAvailable: true });
      const available = getVoiceSessionSnapshot();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(available).not.toBe(unavailable);
      expect(available.reconnectRetryAvailable).toBe(true);
      publish();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getVoiceSessionSnapshot()).toBe(available);

      machine.setReconnecting({ ...owner, reconnecting: true, retryAvailable: false });
      expect(listener).toHaveBeenCalledTimes(2);
      expect(getVoiceSessionSnapshot().reconnectRetryAvailable).toBeUndefined();
      expect(getVoiceSessionSnapshot().presentationState).toBe('reconnecting');
    } finally {
      unsubscribe();
      unsubscribeMachine();
      machine.reset();
      const { resetVoiceSessionRuntimeStateForTests } = await import('./voiceSessionStore');
      await resetVoiceSessionRuntimeStateForTests();
    }
  });

  it('does not notify external-store subscribers when setVoiceSessionSnapshot receives an identical snapshot', async () => {
    vi.resetModules();

    const { setVoiceSessionSnapshot, subscribeToVoiceSessionSnapshot } = await import('./voiceSessionStore');
    const snap = {
      adapterId: 'local_direct',
      sessionId: 's1',
      status: 'connected' as const,
      mode: 'idle' as const,
      canStop: true,
    };

    setVoiceSessionSnapshot(snap);
    const listener = vi.fn();
    const unsubscribe = subscribeToVoiceSessionSnapshot(listener);

    try {
      setVoiceSessionSnapshot({ ...snap });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
