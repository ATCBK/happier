import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { getDefaultModelPackId } from '@happier-dev/protocol/voice/modelPacks/catalog';
import { createMemFs } from '@/voice/modelPacks/installerTestFs';
import { t } from '@/text';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const filesystem = createMemFs();
const requested = () => createDeferred<AbortSignal>();
let download = requested();
const packId = getDefaultModelPackId('stt_sherpa');
if (!packId) throw new Error('Expected the canonical STT pack');
const nativeDialogs = vi.hoisted(() => ({
  alert: vi.fn<typeof import('react-native')['Alert']['alert']>(),
  prompt: vi.fn<typeof import('react-native')['Alert']['prompt']>(),
}));
const route = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
  .createExpoRouterMock({ pathname: () => route.pathname }).module);
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' }, { Alert: nativeDialogs }));
let account: Awaited<ReturnType<typeof import('../../../voiceSettingsAccountTestHarness')['createVoiceSettingsAccountTestHarness']>>;
afterEach(async () => { standardCleanup(); vi.unstubAllGlobals(); await account.dispose(); });

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('expo-file-system', () => filesystem.fs);
// Node selects portable sentinels; bind the complete native implementation.
vi.mock('@/voice/settings/voiceDeviceModelPackOperation', () => import('@/voice/settings/voiceDeviceModelPackOperation.native'));

// Load the real owner graph during collection, outside rendered interaction timeouts.
const { LocalNeuralSttSettings } = await import('./LocalNeuralSttSettings.native');
const { createVoiceSettingsAccountTestHarness } = await import('../../../voiceSettingsAccountTestHarness');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { SETTINGS_ROUTES } = await import('@/components/settings/catalog/routes');

describe('LocalNeuralSttSettings native model download accessory', () => {
  beforeEach(async () => {
    filesystem.files.clear();
    download = requested();
    nativeDialogs.alert.mockClear();
    nativeDialogs.prompt.mockClear();
    route.pathname = '/';
    account = await createVoiceSettingsAccountTestHarness(settingsParse({
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] } },
      voice: { providerId: 'local_conversation', providers: { local_conversation: { schemaVersion: 1, config: {
        stt: { provider: 'local_neural', localNeural: { assetId: packId, execution: 'device' } },
      } } } },
    }));
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = options.signal;
        if (!signal) throw new Error('Expected an admitted installer cancellation signal');
        download.resolve(signal);
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })));
  });

  it.each(['conversation', 'dictation'] as const)('keeps %s download cancellation outside the row with named button semantics', async purpose => {
    if (purpose === 'dictation') {
      route.pathname = SETTINGS_ROUTES.voiceDictation;
      // Conversation STT is deliberately different: its Action cannot prepare this Dictation pack.
      account.replaceVoice(voiceSettingsParse({ ...account.settings.voice,
        providers: { ...account.settings.voice.providers, local_conversation: { schemaVersion: 1, config: {
          stt: { provider: 'device' },
        } } },
        dictation: { ...account.settings.voice.dictation, sttBinding: 'explicit', stt: { provider: 'local_neural',
          localNeural: { assetId: packId, execution: 'device' } } },
      }));
    }
    const setCfg = vi.fn();
    const { tree } = await renderScreen(<LocalNeuralSttSettings
      cfg={{
        provider: 'local_neural',
        localNeural: {
          assetId: packId,
          language: null,
          execution: 'device',
        },
      }}
      setCfg={setCfg}
      popoverBoundaryRef={null}
    />);
    await act(async () => {});

    const findModelRow = () => tree.root.findAll((node) => (
      node.props.title === t('settingsVoice.local.localNeuralStt.modelFiles.title')
      && typeof node.props.onPress === 'function'
      && node.props.rightElement !== undefined
    ))[0];
    expect(findModelRow()).toBeTruthy();
    await act(async () => {
      findModelRow()?.props.onPress();
      await Promise.resolve();
    });
    let signal!: AbortSignal;
    await act(async () => { signal = await download.promise; });

    const modelRow = findModelRow();
    expect(modelRow).toBeTruthy();
    expect(modelRow?.props.rightElementOutsidePressable).toBe(true);

    const cancelButton = tree.root.findAllByProps({ accessibilityLabel: t('common.cancel') })
      .find((node) => String(node.type) === 'Pressable');
    expect(cancelButton).toBeTruthy();
    expect(cancelButton!.props.accessibilityRole).toBe('button');

    const stopPropagation = vi.fn();
    await act(async () => {
      cancelButton!.props.onPress({ stopPropagation });
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
    await vi.waitFor(() => expect(findModelRow()?.props.rightElementOutsidePressable).toBe(false));
    expect(filesystem.files.size).toBe(0);
    expect(setCfg).not.toHaveBeenCalled();
  });

  it('types a custom language inline after choosing Custom in the language menu', async () => {
    const setCfg = vi.fn();
    const cfg = {
      provider: 'local_neural' as const,
      localNeural: { assetId: packId, language: null, execution: 'device' as const },
    };
    const { tree } = await renderScreen(<LocalNeuralSttSettings cfg={cfg} setCfg={setCfg} popoverBoundaryRef={null} />);
    await act(async () => {});

    const languageMenu = tree.root.findAll((node) => (
      node.props.itemTrigger?.title === t('settingsVoice.local.localNeuralStt.language.title')
      && typeof node.props.onSelect === 'function'
    ))[0];
    await act(async () => { languageMenu!.props.onSelect('__custom__'); });

    const field = () => tree.root.findAll((node) => (
      node.props.testID === 'settings.voice.localNeuralStt.language.custom.field'
      && typeof node.props.onChangeText === 'function'
    ))[0]!;
    await act(async () => { field().props.onChangeText('fr-CA'); });
    await act(async () => { field().props.onBlur(); });

    expect(nativeDialogs.prompt).not.toHaveBeenCalled();
    expect(setCfg).toHaveBeenLastCalledWith({ ...cfg, localNeural: { ...cfg.localNeural, language: 'fr-CA' } });
  });

  it('offers and removes a resumable download through the existing remove row', async () => {
    const scratch = `${filesystem.root}/.${packId}.scratch/model.onnx`;
    filesystem.files.set(scratch, new Uint8Array([1, 2, 3]));
    nativeDialogs.alert.mockImplementationOnce((_title, _message, buttons) => {
      buttons?.find(button => button.style !== 'cancel')?.onPress?.();
    });
    const { tree } = await renderScreen(<LocalNeuralSttSettings
      cfg={{ provider: 'local_neural', localNeural: { assetId: packId, language: null, execution: 'device' } }}
      setCfg={vi.fn()} popoverBoundaryRef={null}
    />);
    const removeRow = () => tree.root.findAll(node =>
      node.props.title === t('settingsVoice.local.localNeuralStt.removeModelFiles.title'))
      .find(node => typeof node.props.onPress === 'function');
    await vi.waitFor(() => expect(removeRow()).toBeDefined());
    await act(async () => { removeRow()!.props.onPress(); });
    await vi.waitFor(() => expect(filesystem.files.has(scratch)).toBe(false));
    await vi.waitFor(() => expect(removeRow()).toBeUndefined());
  });
});
