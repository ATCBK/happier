import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installLocalTtsCommonModuleMocks } from './localTtsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async (..._args: any[]) => true);
const prepareKokoroTtsSpy = vi.fn();
const getModelPackInstallSummarySpy = vi.fn();
const removeModelPackSpy = vi.fn(async (..._args: any[]) => {});
const runtime = vi.hoisted(() => ({ supported: false }));

installLocalTtsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: any[]) => modalAlertSpy(...args),
                confirm: (...args: any[]) => modalConfirmSpy(...args),
            },
        }).module;
    },
    // Interpolated values stay visible so assertions can read the sizes and counts a user sees.
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => (
                params ? `${key}(${Object.values(params).join('|')})` : key
            ),
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props, props.subtitle),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) =>
    React.createElement(
      'DropdownMenu',
      props,
      typeof props.trigger === 'function' ? props.trigger({ open: false, toggle: () => {} }) : props.trigger,
    ),
}));

vi.mock('@/voice/kokoro/runtime/kokoroSupport', () => ({
  isKokoroRuntimeSupported: () => runtime.supported,
}));

vi.mock('@/voice/modelPacks/manifests', () => ({
  resolveModelPackManifestUrl: () => 'https://example.com/manifest.json',
}));

// The native runtime and the on-device pack store are system boundaries in the Node test process.
vi.mock('@/voice/kokoro/runtime/synthesizeKokoroWav', () => ({
  prepareKokoroTts: (...args: any[]) => prepareKokoroTtsSpy(...args),
}));

vi.mock('@/voice/modelPacks/installer.native', () => ({
  checkModelPackUpdateAvailable: vi.fn(),
  ensureModelPackInstalled: vi.fn(),
  getModelPackInstallSummary: (...args: any[]) => getModelPackInstallSummarySpy(...args),
  removeModelPack: (...args: any[]) => removeModelPackSpy(...args),
}));

vi.mock('./useLocalNeuralKokoroVoiceCatalog.native', () => ({
  useLocalNeuralKokoroVoiceCatalog: () => [{ id: 'af_heart', title: 'Heart' }],
}));

vi.mock('@/voice/output/KokoroTtsController', () => ({
  speakKokoroText: vi.fn(),
}));

vi.mock('@/voice/runtime/VoicePlaybackController', () => ({
  createVoicePlaybackController: () => ({ registerStopper: () => () => {}, interrupt: vi.fn() }),
}));

const MB = 1024 * 1024;
const notInstalled = (partialBytes: number) => ({ installed: false, packDirUri: 'file:///packs', manifest: null, partialBytes });

async function renderSettings() {
  const { LocalNeuralTtsSettings } = await import('./LocalNeuralTtsSettings.native');
  const screen = await renderScreen(React.createElement(LocalNeuralTtsSettings, {
    cfgKokoro: { model: 'kokoro', assetId: null, voiceId: null, speed: null },
    setKokoro: vi.fn(),
    networkTimeoutMs: 1000,
    popoverBoundaryRef: null,
  }));
  await act(async () => {});
  const row = (title: string) => screen.findAll((n) => n.type === ('Item' as never) && n.props?.title === title)[0]!;
  const collectText = (node: ReactTestInstance | string): string => (
    typeof node === 'string' ? node : node.children.map(collectText).join(' ')
  );
  const rowText = (title: string) => `${row(title).props.detail ?? ''} ${collectText(row(title))}`;
  return { screen, row, rowText };
}

const MODEL_ROW = 'settingsVoice.local.kokoro.model.title';
const REMOVE_ROW = 'settingsVoice.local.kokoro.removeAssets.title';

describe('LocalNeuralTtsSettings (native)', () => {
  beforeEach(() => {
    runtime.supported = false;
    modalAlertSpy.mockClear();
    modalConfirmSpy.mockClear();
    prepareKokoroTtsSpy.mockReset();
    removeModelPackSpy.mockClear();
    getModelPackInstallSummarySpy.mockReset();
    getModelPackInstallSummarySpy.mockResolvedValue(notInstalled(0));
  });

  it('blocks model download when runtime is unsupported and surfaces a clear error', async () => {
    const { row } = await renderSettings();

    await act(async () => {
      await pressTestInstanceAsync(row(MODEL_ROW));
    });

    expect(prepareKokoroTtsSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalled();
    expect(modalAlertSpy.mock.calls[0]?.[1]).toBe('settingsVoice.local.kokoro.alerts.runtimeUnsupported.body');
  });

  it('shows downloaded bytes and files below the model row while downloading', async () => {
    runtime.supported = true;
    prepareKokoroTtsSpy.mockImplementation((opts: { onProgress: (p: unknown) => void }) => {
      opts.onProgress({ loaded: 84.2 * MB, total: 186.1 * MB, filesDone: 120, filesTotal: 362 });
      return new Promise(() => {});
    });
    const { screen, row, rowText } = await renderSettings();

    await act(async () => {
      await pressTestInstanceAsync(row(MODEL_ROW));
    });

    expect(row(MODEL_ROW).props.detail).toBe('45%');
    expect(rowText(MODEL_ROW)).toContain('84.2 MB|186 MB|120|362');
    const bar = screen.findAll((n) => n.props?.accessibilityRole === 'progressbar')[0];
    expect(bar?.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 45 });
  });

  it('offers retrying a failed download and keeps what it already saved', async () => {
    runtime.supported = true;
    prepareKokoroTtsSpy.mockRejectedValueOnce(new Error('model_pack_download_failed:503'));
    const { row, rowText } = await renderSettings();
    getModelPackInstallSummarySpy.mockResolvedValue(notInstalled(4.8 * MB));

    await act(async () => {
      await pressTestInstanceAsync(row(MODEL_ROW));
    });
    await act(async () => {});

    expect(modalAlertSpy).toHaveBeenCalled();
    expect(rowText(MODEL_ROW)).toContain('4.8 MB');
    expect(typeof row(MODEL_ROW).props.onPress).toBe('function');
  });

  it('describes a partial download from an earlier session as resumable', async () => {
    getModelPackInstallSummarySpy.mockResolvedValue(notInstalled(12 * MB));
    const { rowText } = await renderSettings();

    expect(rowText(MODEL_ROW)).toContain('12.0 MB');
  });

  it('discards a partial download after confirmation', async () => {
    getModelPackInstallSummarySpy.mockResolvedValue(notInstalled(84.2 * MB));
    const { row } = await renderSettings();

    expect(row(REMOVE_ROW).props.detail).toBe('84.2 MB');
    getModelPackInstallSummarySpy.mockResolvedValue(notInstalled(0));
    await act(async () => {
      await pressTestInstanceAsync(row(REMOVE_ROW));
    });
    await act(async () => {});

    expect(String(modalConfirmSpy.mock.calls[0]?.[1] ?? '')).toContain('84.2 MB');
    expect(removeModelPackSpy).toHaveBeenCalledWith({ packId: expect.any(String) });
    expect(row(REMOVE_ROW).props.onPress).toBeUndefined();
  });

  it('keeps the remove row inert when nothing is on disk', async () => {
    const { row } = await renderSettings();
    expect(row(REMOVE_ROW).props.onPress).toBeUndefined();
  });
});
