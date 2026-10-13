import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createVoiceSpeechOutputBoundary } from '@/dev/testkit/harness/voiceSpeechOutputBoundary';
import { KOKORO_DEFAULT_TTS_PACK_ID } from '@happier-dev/protocol/voice/modelPacks/catalog';
const boundary = createVoiceSpeechOutputBoundary({ getAccount: () => {
  throw new Error('Device model preparation must not dispatch a daemon RPC');
} });
let { filesystem } = boundary.reset();

vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { Alert } = await import('react-native');
const { t } = await import('@/text');
// The native dialog API is the OS boundary; ModalManager and text remain real.
const alert = vi.spyOn(Alert, 'alert').mockImplementation(() => {});

const { useLocalNeuralModelPackState } = await import('./useLocalNeuralModelPackState.native');
const input = { packId: KOKORO_DEFAULT_TTS_PACK_ID, manifestUrl: null };

describe('useLocalNeuralModelPackState (native)', () => {
  beforeEach(() => {
    ({ filesystem } = boundary.reset());
    boundary.platform.value = 'ios';
    boundary.setNativeAvailable(false);
    alert.mockClear();
  });
  afterEach(() => { standardCleanup(); boundary.disposeNativeSdkBridge(); vi.unstubAllGlobals(); });
  afterAll(async () => { alert.mockRestore(); await boundary.disposeAudioSession(); });

  it('surfaces prepare errors via Modal.alert', async () => {
    const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: input });
    await act(async () => { await hook.getCurrent().prepareModel(); });
    expect(hook.getCurrent().modelStatus).toBe('error');
    expect(alert).toHaveBeenCalledWith(t('common.error'), 'kokoro_native_module_unavailable', undefined);
    expect(filesystem.files.size).toBe(0);
  });

  it('settles a cancelled download back to idle instead of pinning downloading', async () => {
    boundary.setNativeAvailable(true);
    const requested = createDeferred<AbortSignal>();
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = options.signal;
        if (!signal) throw new Error('Expected an admitted installer cancellation signal');
        requested.resolve(signal);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })));
    const hook = await renderHook(useLocalNeuralModelPackState, { initialProps: input });
    let operation!: Promise<void>;
    await act(async () => { operation = hook.getCurrent().prepareModel(); });
    const signal = await requested.promise;
    expect(hook.getCurrent().modelStatus).toBe('downloading');
    await act(async () => { hook.getCurrent().cancelPrepare(); await operation; });
    expect(signal.aborted).toBe(true);
    expect(hook.getCurrent().modelStatus).toBe('idle');
    expect(hook.getCurrent().downloadProgress).toBeNull();
    expect(filesystem.files.size).toBe(0);
    expect(alert).not.toHaveBeenCalled();
  });
});
