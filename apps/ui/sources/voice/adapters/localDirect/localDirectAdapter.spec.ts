import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getStorage, loadLocalVoiceEngineWithCompatState, localVoiceSpeechOutputBoundary,
  registerLocalVoiceEngineHarnessHooks, warmLocalVoiceEngineHarnessGraph,
} from '@/voice/local/localVoiceEngine.testHarness';

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local direct voice adapter', () => {
  registerLocalVoiceEngineHarnessHooks({ resetModulesBetweenTests: false });
  let adapter: ReturnType<typeof import('./localDirectAdapter')['createLocalDirectVoiceAdapter']>;
  beforeEach(async () => {
    await loadLocalVoiceEngineWithCompatState();
    const storage = await getStorage();
    storage.__setState({ settings: { ...storage.getState().settings,
      voice: { ...storage.getState().settings.voice, providerId: 'local_direct' } } });
    const { createLocalDirectVoiceAdapter } = await import('./localDirectAdapter');
    adapter = createLocalDirectVoiceAdapter();
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    registerVoiceAdapters([adapter]);
  });

  it('projects a disconnected runtime snapshot as a disconnected local session snapshot', () => {
    expect(adapter.getSnapshot()).toEqual({ adapterId: 'local_direct', sessionId: null,
      status: 'disconnected', mode: 'idle', canStop: false });
  });

  it('owns session-scoped surface semantics and fails closed when unselected', () => {
    const selected = { providerId: 'local_direct', providers: { local_direct: { schemaVersion: 1, config: {} } } };
    expect(adapter.resolveSurfaceCapabilities?.(selected)).toEqual({ allowsGlobalStart: false,
      controlSessionScope: 'surface', requiresVoiceAgentFeature: false, bargeInEnabled: true, cancelResponse: 'immediate' });
    expect(adapter.resolveSurfaceCapabilities?.({ ...selected,
      providers: { local_direct: { schemaVersion: 1, config: { tts: { bargeInEnabled: false } } } } })?.bargeInEnabled).toBe(false);
    expect(adapter.resolveSurfaceCapabilities?.({ ...selected, providerId: 'local_conversation' })).toBeNull();
  });

  it('projects the connected idle state after an actual empty recorded turn', async () => {
    await adapter.toggle({ sessionId: 's1' });
    await adapter.toggle({ sessionId: 's1' });
    expect(adapter.getSnapshot()).toMatchObject({ adapterId: 'local_direct', sessionId: 's1',
      status: 'connected', mode: 'idle', canStop: true });
  });

  it('toggle acquires real capture and publishes listening', async () => {
    await adapter.toggle({ sessionId: 's1' });
    expect(adapter.getSnapshot()).toMatchObject({ sessionId: 's1', status: 'connected', mode: 'listening', canStop: true });
    expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBeGreaterThan(0);
  });

  it('a toggle for another surface finishes the active recorded turn without retiring its session', async () => {
    await adapter.toggle({ sessionId: 's1' });
    await adapter.toggle({ sessionId: 's-next' });
    expect(adapter.getSnapshot()).toMatchObject({ sessionId: 's1', status: 'connected', mode: 'idle', canStop: true });
  });

  it('stop retires the real local session and its capture', async () => {
    await adapter.toggle({ sessionId: 's1' });
    await adapter.stop({ sessionId: 's1' });
    expect(adapter.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
  });

  it('interrupt returns to connected idle without hanging up the local session', async () => {
    await adapter.toggle({ sessionId: 's1' });
    await adapter.interrupt({ sessionId: 's1' });
    expect(adapter.getSnapshot()).toMatchObject({ sessionId: 's1', status: 'connected', mode: 'idle', canStop: true });
  });

  it('mute changes the actual runtime snapshot and can be reversed', async () => {
    await adapter.toggle({ sessionId: 's1' });
    await adapter.setMuted({ sessionId: 's1', muted: true });
    expect(adapter.getSnapshot()).toMatchObject({ sessionId: 's1', micMuted: true, status: 'connected' });
    await adapter.setMuted({ sessionId: 's1', muted: false });
    expect(adapter.getSnapshot().micMuted).not.toBe(true);
  });
});
