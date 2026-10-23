import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import { createOpenAiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/openAiVoiceRuntime';
import { installVoiceWebRtcBrowserBoundary } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createNativeMicSession } from '@/voice/runtime/mic/NativeMicSession';
import { rejectRefusedMicrophone, requestMicrophonePermission } from '@/utils/platform/microphonePermissions';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
const audio = vi.hoisted(() => ({ setAudioModeAsync: vi.fn(async (_mode: unknown) => undefined) }));
vi.mock('expo-audio', () => ({ AudioModule: audio }));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

describe('generated OpenAI runtime stop ordering', () => {
  it('ends while OS permission acquisition is pending and releases late media without publishing connected', async () => {
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    let runtime: Awaited<ReturnType<typeof environment.createRuntime>> | null = null;
    let completeCapture = () => {};
    let unsubscribe: (() => void) | undefined;
    onTestFinished(async () => {
      unsubscribe?.();
      completeCapture();
      try { await runtime?.runtime.dispose(); }
      finally {
        runtime?.hostLease.revoke();
        try { await environment.dispose(); }
        finally { browser.restore(); }
      }
    });
    audio.setAudioModeAsync.mockReset().mockResolvedValue(undefined);
    const permissionProbe = browser.allocateCapture();
    const lateCapture = browser.allocateCapture();
    const captureEntered = createDeferred<void>();
    // The OS may finish after cancellation. Only its acquisition is held;
    // the actual permission parser and NativeMicSession own invalidation.
    const capture = new Promise<MediaStream>(resolve => {
      completeCapture = () => resolve(lateCapture.stream);
    });
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockResolvedValueOnce(permissionProbe.stream)
      .mockImplementationOnce(() => { captureEntered.resolve(); return capture; });
    // Preserve lazy physical SDK getters: there is deliberately no peer yet.
    // Only factory selection differs from the real WebMicSession recipe.
    const nativeBrowser = new Proxy({} as typeof browser, {
      get(_target, key) {
        if (key === 'createMicSession') return (options: Parameters<typeof createNativeMicSession>[0]) => createNativeMicSession({
          ...options,
          ensurePermission: async () => rejectRefusedMicrophone(await requestMicrophonePermission(), () => {}),
          acquireStream: () => navigator.mediaDevices.getUserMedia({ audio: true, video: false }),
        });
        return Reflect.get(browser, key);
      },
    });
    runtime = await environment.createRuntime(nativeBrowser);
    const { adapter, controlSessionId } = runtime;
    const statuses: string[] = [];
    unsubscribe = adapter.subscribe?.(() => statuses.push(adapter.getSnapshot().status));
    const start = adapter.start({ sessionId: controlSessionId, requestedTargetSessionAddress: null });
    await captureEntered.promise;
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(adapter.getSnapshot().status).toBe('connecting');
    expect(audio.setAudioModeAsync.mock.calls[0]?.[0]).toMatchObject({ shouldPlayInBackground: true });
    expect(audio.setAudioModeAsync.mock.invocationCallOrder[0]).toBeLessThan(getUserMedia.mock.invocationCallOrder[1]!);
    expect(permissionProbe.track.readyState).toBe('ended');
    expect(lateCapture.track.readyState).toBe('live');

    await adapter.stop({ sessionId: controlSessionId });
    await start;
    expect(adapter.getSnapshot().status).toBe('disconnected');
    expect(statuses).not.toContain('connected');
    expect(browser.peers).toHaveLength(0);
    expect(environment.providerFetch.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.openai.com/v1/realtime/client_secrets',
    ]);
    expect(audio.setAudioModeAsync.mock.calls.at(-1)?.[0]).toEqual({ shouldPlayInBackground: false });
    // Stop has completed while acquisition is still held. Its eventual
    // physical track must be retired without signaling or state revival.
    expect(lateCapture.track.readyState).toBe('live');
    completeCapture();
    await lateCapture.stopped;
    expect(lateCapture.track.readyState).toBe('ended');
    expect(adapter.getSnapshot().status).toBe('disconnected');
    expect(statuses).not.toContain('connected');
    expect(browser.peers).toHaveLength(0);
  });
});
