import React from 'react';
import { act, ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installLocalTtsCommonModuleMocks } from '../localTts/localTtsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const prepareKokoroTtsSpy = vi.fn();
const getModelPackInstallSummarySpy = vi.fn();
const checkModelPackUpdateAvailableSpy = vi.fn();
const ensureModelPackInstalledSpy = vi.fn();

installLocalTtsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            spies: {
                alert: modalAlertSpy,
            },
        }).module;
    },
});

vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => ({
  prepareKokoroTts: (...args: any[]) => prepareKokoroTtsSpy(...args),
}));

vi.mock('@/voice/modelPacks/installer.native', () => ({
  checkModelPackUpdateAvailable: (...args: any[]) => checkModelPackUpdateAvailableSpy(...args),
  ensureModelPackInstalled: (...args: any[]) => ensureModelPackInstalledSpy(...args),
  getModelPackInstallSummary: (...args: any[]) => getModelPackInstallSummarySpy(...args),
  removeModelPack: vi.fn(),
}));

function createHarness(
  useHook: typeof import('./useNativeModelPackState.native').useNativeModelPackState,
  role: 'stt' | 'tts' = 'tts',
) {
  return function Harness(props: { packId: string; manifestUrl: string | null; networkTimeoutMs: number }) {
    const state = useHook({ ...props, role });
    return React.createElement('Harness', {
      onPrepare: state.prepareModel, onCancel: state.cancelPrepare, onCheckForUpdates: state.checkForUpdates,
      modelStatus: state.modelStatus,
    });
  };
}

describe('useNativeModelPackState (native)', () => {
  beforeEach(() => {
    modalAlertSpy.mockClear();
    prepareKokoroTtsSpy.mockClear();
    getModelPackInstallSummarySpy.mockClear();
    getModelPackInstallSummarySpy.mockResolvedValue({ installed: false, packDirUri: 'file:///packs', manifest: null });
  });

  it('surfaces prepare errors via Modal.alert', async () => {
    prepareKokoroTtsSpy.mockRejectedValueOnce(new Error('kokoro_native_module_unavailable'));

    const { useNativeModelPackState } = await import('./useNativeModelPackState.native');
    const Harness = createHarness(useNativeModelPackState);

    let tree!: ReactTestRenderer;
    tree = (await renderScreen(React.createElement(Harness, { packId: 'dummy-pack', manifestUrl: null, networkTimeoutMs: 1000 }))).tree;
    await act(async () => {});

    const node = tree.findByType('Harness');
    await act(async () => {
      invokeTestInstanceHandler(await node, 'onPrepare', );
    });

    expect(modalAlertSpy).toHaveBeenCalled();
    expect(String(modalAlertSpy.mock.calls[0]?.[1] ?? '')).toContain('kokoro_native_module_unavailable');
  });

  it.each(['stt', 'tts'] as const)('reports the still-installed %s pack as ready after a failed update', async (role) => {
    const installedSummary = { installed: true, packDirUri: 'file:///packs', manifest: null };
    getModelPackInstallSummarySpy.mockResolvedValue(installedSummary);
    checkModelPackUpdateAvailableSpy.mockResolvedValueOnce({
      installed: true, updateAvailable: true, installedManifest: null, remoteManifest: null,
    });
    ensureModelPackInstalledSpy.mockRejectedValueOnce(new Error('model_pack_download_failed:503'));

    const { useNativeModelPackState } = await import('./useNativeModelPackState.native');
    const Harness = createHarness(useNativeModelPackState, role);
    const tree = (await renderScreen(React.createElement(Harness, {
      packId: 'dummy-pack', manifestUrl: 'https://example.com/manifest.json', networkTimeoutMs: 1000,
    }))).tree;
    await act(async () => {});
    expect(tree.findByType('Harness').props.modelStatus).toBe('ready');

    await act(async () => {
      invokeTestInstanceHandler(tree.findByType('Harness'), 'onCheckForUpdates');
    });
    await act(async () => {});

    expect(String(modalAlertSpy.mock.calls.at(-1)?.[0] ?? '')).toContain('updateFailed');
    expect(tree.findByType('Harness').props.modelStatus).toBe('ready');
  });

  it('leaves the downloading state when a download is cancelled so it can be retried', async () => {
    prepareKokoroTtsSpy.mockImplementationOnce((opts: { signal: AbortSignal }) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));

    const { useNativeModelPackState } = await import('./useNativeModelPackState.native');
    const Harness = createHarness(useNativeModelPackState);
    const tree = (await renderScreen(React.createElement(Harness, {
      packId: 'dummy-pack', manifestUrl: 'https://example.com/manifest.json', networkTimeoutMs: 1000,
    }))).tree;
    await act(async () => {});

    await act(async () => {
      invokeTestInstanceHandler(tree.findByType('Harness'), 'onPrepare');
    });
    expect(tree.findByType('Harness').props.modelStatus).toBe('downloading');

    await act(async () => {
      invokeTestInstanceHandler(tree.findByType('Harness'), 'onCancel');
    });
    await act(async () => {});

    expect(tree.findByType('Harness').props.modelStatus).toBe('idle');
    expect(modalAlertSpy).not.toHaveBeenCalled();
  });
});
