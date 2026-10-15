import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async (..._args: any[]) => true);
const ensureModelPackInstalledSpy = vi.fn();
const getModelPackInstallSummarySpy = vi.fn();
const removeModelPackSpy = vi.fn(async (..._args: any[]) => {});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

// Interpolated values stay visible so assertions can read the sizes and counts a user sees.
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}(${Object.values(params).join('|')})` : key),
  });
});

vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({
    spies: {
      alert: (...args: any[]) => modalAlertSpy(...args),
      confirm: (...args: any[]) => modalConfirmSpy(...args),
    },
  }).module;
});

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props, props.subtitle),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/voice/modelPacks/manifests', () => ({
  resolveModelPackManifestUrl: () => 'https://example.com/manifest.json',
}));

// The on-device pack store and its native downloads are system boundaries in the Node test process.
vi.mock('@/voice/modelPacks/installer.native', () => ({
  checkModelPackUpdateAvailable: vi.fn(),
  ensureModelPackInstalled: (...args: any[]) => ensureModelPackInstalledSpy(...args),
  getModelPackInstallSummary: (...args: any[]) => getModelPackInstallSummarySpy(...args),
  removeModelPack: (...args: any[]) => removeModelPackSpy(...args),
}));

const MB = 1024 * 1024;
const notInstalled = (partialBytes: number) => ({ installed: false, packDirUri: 'file:///packs', manifest: null, partialBytes });
const MODEL_ROW = 'settingsVoice.local.localNeuralStt.modelFiles.title';
const REMOVE_ROW = 'settingsVoice.local.localNeuralStt.removeModelFiles.title';

function collectText(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(collectText).join(' ');
}

async function renderSettings() {
  const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.native');
  const screen = await renderScreen(React.createElement(LocalNeuralSttSettings, {
    cfg: { provider: 'local_neural', localNeural: { assetId: 'stt-pack', language: null } } as any,
    setCfg: vi.fn(),
    popoverBoundaryRef: null,
  }));
  await act(async () => {});
  const row = (title: string) => screen.findAll((n) => n.type === ('Item' as never) && n.props?.title === title)[0]!;
  const rowText = (title: string) => `${row(title).props.detail ?? ''} ${collectText(row(title))}`;
  return { screen, row, rowText };
}

describe('LocalNeuralSttSettings (native)', () => {
  beforeEach(() => {
    modalAlertSpy.mockClear();
    modalConfirmSpy.mockClear();
    ensureModelPackInstalledSpy.mockReset();
    removeModelPackSpy.mockClear();
    getModelPackInstallSummarySpy.mockReset();
    getModelPackInstallSummarySpy.mockResolvedValue(notInstalled(0));
  });

  it('shows downloaded bytes and files below the model row while downloading', async () => {
    ensureModelPackInstalledSpy.mockImplementation((opts: { onProgress: (p: unknown) => void }) => {
      opts.onProgress({ loaded: 30 * MB, total: 60 * MB, filesDone: 3, filesTotal: 8 });
      return new Promise(() => {});
    });
    const { screen, row, rowText } = await renderSettings();

    await act(async () => {
      await pressTestInstanceAsync(row(MODEL_ROW));
    });

    expect(row(MODEL_ROW).props.detail).toBe('50%');
    expect(rowText(MODEL_ROW)).toContain('30.0 MB|60.0 MB|3|8');
    const bar = screen.findAll((n) => n.props?.accessibilityRole === 'progressbar')[0];
    expect(bar?.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 50 });
  });

  it('offers retrying a failed download and keeps what it already saved', async () => {
    ensureModelPackInstalledSpy.mockRejectedValueOnce(new Error('model_pack_download_failed:503'));
    const { row, rowText } = await renderSettings();
    getModelPackInstallSummarySpy.mockResolvedValue(notInstalled(4.8 * MB));

    await act(async () => {
      await pressTestInstanceAsync(row(MODEL_ROW));
    });
    await act(async () => {});

    expect(modalAlertSpy).toHaveBeenCalled();
    expect(rowText(MODEL_ROW)).toContain('4.8 MB');
    expect(typeof row(REMOVE_ROW).props.onPress).toBe('function');
  });

  it('discards a partial download after confirmation', async () => {
    getModelPackInstallSummarySpy.mockResolvedValue(notInstalled(12 * MB));
    const { row } = await renderSettings();

    expect(row(REMOVE_ROW).props.detail).toBe('12.0 MB');
    getModelPackInstallSummarySpy.mockResolvedValue(notInstalled(0));
    await act(async () => {
      await pressTestInstanceAsync(row(REMOVE_ROW));
    });
    await act(async () => {});

    expect(String(modalConfirmSpy.mock.calls[0]?.[1] ?? '')).toContain('12.0 MB');
    expect(removeModelPackSpy).toHaveBeenCalledWith({ packId: 'stt-pack' });
    expect(row(REMOVE_ROW).props.onPress).toBeUndefined();
  });
});
