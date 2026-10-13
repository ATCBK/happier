import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceConnectionDriver } from '@/voice/runtime/connection/VoiceRealtimeConnection';
// Exercise Metro's native owner beneath the host while substituting the native ABI only.
vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' }, { NativeModules: { WebRTCModule: {} } });
});
vi.mock('@/voice/runtime/nativeWebRtcRuntime', async () => import('@/voice/runtime/nativeWebRtcRuntime.native'));

// Warm the real host graph during collection, not the native admission deadline.
const { createBundledConversationRuntimeHostLease } = await import('./bundledConversationRuntimeHost');

describe('bundled conversation runtime host native WebRTC admission', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects provider-managed native WebRTC before the ElevenLabs SDK connection is created', async () => {
    const driver = { open: async () => undefined, sendControl: async () => undefined, close: async () => undefined } satisfies VoiceConnectionDriver;
    const lease = createBundledConversationRuntimeHostLease();

    try {
      expect(() => lease.host.createSdkHandleConnection({ driver })).toThrow(
        expect.objectContaining({ code: 'voice_native_webrtc_incompatible' }),
      );
    } finally {
      lease.revoke();
    }
  });
});
