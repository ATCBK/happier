import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/openAiVoiceRuntime';
import { installVoiceWebRtcBrowserBoundary, TestVoiceWebRtcPeer } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { waitForTestEvent } from '@/dev/testkit';

vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web' } }));
vi.mock('expo-router', async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/', params: {}, segments: [] }).module);

describe('voiceSessionManager', () => {
  let environment: Awaited<ReturnType<typeof createOpenAiVoiceRuntimeEnvironment>>;
  let browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>;
  let runtime: Awaited<ReturnType<typeof environment.createRuntime>>;
  let lifecycle: ReturnType<typeof import('./voiceSessionLifecycleController').createVoiceSessionLifecycleController>;
  let manager: ReturnType<typeof import('./voiceSessionManager').createVoiceSessionManager>;

  beforeEach(async () => {
    environment = await createOpenAiVoiceRuntimeEnvironment();
    browser = installVoiceWebRtcBrowserBoundary();
    runtime = await environment.createRuntime(browser);
    const [{ createVoiceSessionLifecycleController }, { createVoiceSessionManager },
      { getVoiceSessionLifecycleController, setVoiceSessionLifecycleController }] = await Promise.all([
      import('./voiceSessionLifecycleController'), import('./voiceSessionManager'), import('./voiceSessionLifecycleControllerStore'),
    ]);
    lifecycle = createVoiceSessionLifecycleController();
    lifecycle.setConfiguredProviderId(runtime.adapter.id);
    setVoiceSessionLifecycleController(lifecycle);
    manager = createVoiceSessionManager({ getLifecycleController: getVoiceSessionLifecycleController });
  });
  afterEach(async () => {
    const { setVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    setVoiceSessionLifecycleController(null);
    await lifecycle?.dispose();
    await runtime?.runtime.dispose();
    runtime?.hostLease.revoke();
    browser?.restore();
    await environment?.dispose();
  });

  async function connect(starting: Promise<void>, peer?: TestVoiceWebRtcPeer) {
    const connectedPeer = peer ?? await Promise.race([browser.peerCreated(), starting.then(() => browser.peer)]);
    expect(browser.peers.length).toBeGreaterThan(0);
    await Promise.race([connectedPeer.dataChannelCreated, starting]);
    expect(connectedPeer.createDataChannel).toHaveBeenCalledWith('oai-events');
    connectedPeer.channel.open();
    await starting;
    expect(runtime.adapter.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
    expect(browser.micSession.getStream()).not.toBeNull();
  }

  it('routes commands through the lifecycle controller', async () => {
    await connect(manager.toggle(null));
    const sessionId = runtime.controlSessionId;
    await manager.interrupt(sessionId);
    await manager.bargeIn(sessionId);
    await manager.setMuted(sessionId, true);
    expect(browser.micTrack.enabled).toBe(false);
    expect(manager.getSnapshot().micMuted).toBe(true);
    manager.sendContextUpdate(sessionId, 'hello from the current session');
    await browser.peer.channel.controlSent(value => value.includes('hello from the current session'));
    expect(browser.peer.channel.sent.some(value => value.includes('hello from the current session'))).toBe(true);
    expect(browser.peer.channel.sent.map(value => JSON.parse(value))
      .some(event => event.type === 'response.cancel')).toBe(true);

    browser.peer.channel.message(JSON.stringify({
      type: 'error', event_id: 'manager-terminal-session',
      error: { code: 'session_expired', message: 'Session expired' },
    }));
    await waitForTestEvent(lifecycle.subscribe, lifecycle.getSnapshot, snapshot => snapshot.status === 'error' && !snapshot.canStop);
    expect(manager.getSnapshot()).toMatchObject({
      status: 'error', canStop: false, errorRecoveryAction: 'retry',
    });
    const nextPeer = new TestVoiceWebRtcPeer();
    vi.mocked(globalThis.RTCPeerConnection).mockImplementationOnce(() => nextPeer as unknown as RTCPeerConnection);
    await connect(manager.retry(sessionId), nextPeer);
    expect(manager.getSnapshot()).toMatchObject({ sessionId, status: 'connected', canStop: true });

    await manager.stop(sessionId);
    expect(manager.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    expect(browser.micSession.getStream()).toBeNull();
    expect(nextPeer.channel.readyState).toBe('closed');
  });

  it('returns the lifecycle-controller snapshot when available', async () => {
    await connect(manager.toggle(null));
    const priorProjection = lifecycle.getSnapshot();
    await manager.setMuted(runtime.controlSessionId, true);
    const [{ getVoiceSessionSnapshot, setVoiceSessionSnapshot }, { createVoiceSessionManager },
      { setVoiceSessionLifecycleController }] = await Promise.all([
      import('./voiceSessionStore'), import('./voiceSessionManager'), import('./voiceSessionLifecycleControllerStore'),
    ]);
    setVoiceSessionLifecycleController(null);
    const standaloneManager = createVoiceSessionManager({ getLifecycleController: () => lifecycle });
    // Seed the real presentation store with its prior projection; the current
    // lifecycle owner must remain authoritative while that projection lags.
    setVoiceSessionSnapshot(priorProjection);
    expect(getVoiceSessionSnapshot().micMuted ?? false).toBe(false);
    expect(standaloneManager.getSnapshot()).toEqual(lifecycle.getSnapshot());
    expect(standaloneManager.getSnapshot()).toMatchObject({
      adapterId: runtime.adapter.id, sessionId: runtime.controlSessionId,
      status: 'connected', canStop: true, micMuted: true,
    });
  });

  it('does not fall back to direct adapter ownership when no lifecycle controller is installed', async () => {
    const { setVoiceSessionLifecycleController } = await import('./voiceSessionLifecycleControllerStore');
    setVoiceSessionLifecycleController(null);
    await connect(runtime.adapter.start({ sessionId: '', requestedTargetSessionAddress: null }));
    const before = [...browser.peer.channel.sent];
    const sessionId = runtime.controlSessionId;
    await manager.toggle(null);
    await manager.retry(sessionId);
    await manager.stop(sessionId);
    await manager.interrupt(sessionId);
    await manager.bargeIn(sessionId);
    await manager.setMuted(sessionId, true);
    manager.sendContextUpdate(sessionId, 'must not reach the registered live adapter');

    expect(manager.getSnapshot()).toEqual({
      adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false,
    });
    // A registered live microphone makes an accidental direct-adapter fallback observable.
    expect(runtime.adapter.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
    expect(browser.micSession.getStream()).not.toBeNull();
    expect(browser.micTrack.enabled).toBe(true);
    expect(browser.micTrack.stop).not.toHaveBeenCalled();
    expect(browser.peer.channel.sent).toEqual(before);
  });
});
